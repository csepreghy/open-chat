use crate::activity_notifications::handle_activity_notification;
use crate::timer_job_types::{DeleteFileReferencesJob, EndPollJob, TimerJob};
use crate::{mutate_state, run_regular_jobs, RuntimeState};
use canister_api_macros::update_candid_and_msgpack;
use canister_timer_jobs::TimerJobs;
use canister_tracing_macros::trace;
use community_canister::send_message::{Response::*, *};
use group_chat_core::SendMessageResult;
use types::{
    ChannelId, ChannelMessageNotification, EventWrapper, Message, MessageContent, MessageIndex, Notification, TimestampMillis,
    UserId,
};

#[update_candid_and_msgpack]
#[trace]
fn send_message(args: Args) -> Response {
    run_regular_jobs();

    mutate_state(|state| send_message_impl(args, state))
}

fn send_message_impl(args: Args, state: &mut RuntimeState) -> Response {
    if state.data.is_frozen() {
        return CommunityFrozen;
    }

    let caller = state.env.caller();
    let now = state.env.now();

    match state.data.members.get_mut(caller) {
        Some(m) => {
            if m.suspended.value {
                return UserSuspended;
            }
            if let Some(version) = args.community_rules_accepted {
                m.accept_rules(version, now);
            }
        }
        None => return UserNotInCommunity,
    };

    let member = state.data.members.get(caller).unwrap();

    if !state.data.check_rules(member) {
        // TODO: Uncomment this once the FE has been updated with "send message" rules checks
        //return RulesNotAccepted;
    }

    if let Some(channel) = state.data.channels.get_mut(&args.channel_id) {
        let user_id = member.user_id;

        match channel.chat.send_message(
            user_id,
            args.thread_root_message_index,
            args.message_id,
            args.content,
            args.replies_to,
            args.mentioned.clone(),
            args.forwarding,
            args.channel_rules_accepted,
            state.data.proposals_bot_user_id,
            now,
        ) {
            SendMessageResult::Success(result) => {
                let event_index = result.message_event.index;
                let message_index = result.message_event.event.message_index;
                let expires_at = result.message_event.expires_at;

                register_timer_jobs(
                    args.channel_id,
                    args.thread_root_message_index,
                    &result.message_event,
                    now,
                    &mut state.data.timer_jobs,
                );

                // Exclude suspended members from notification
                let users_to_notify: Vec<UserId> = result
                    .users_to_notify
                    .into_iter()
                    .filter(|u| state.data.members.get_by_user_id(u).map_or(false, |m| !m.suspended.value))
                    .collect();

                let content = &result.message_event.event.content;
                let notification = Notification::ChannelMessage(ChannelMessageNotification {
                    community_id: state.env.canister_id().into(),
                    channel_id: args.channel_id,
                    thread_root_message_index: args.thread_root_message_index,
                    message_index: result.message_event.event.message_index,
                    event_index: result.message_event.index,
                    community_name: state.data.name.clone(),
                    channel_name: channel.chat.name.clone(),
                    sender: user_id,
                    sender_name: args.sender_name,
                    message_type: content.message_type().to_string(),
                    message_text: content.notification_text(&args.mentioned),
                    image_url: content.notification_image_url(),
                    community_avatar_id: state.data.avatar.as_ref().map(|d| d.id),
                    channel_avatar_id: channel.chat.avatar.as_ref().map(|d| d.id),
                    crypto_transfer: content.notification_crypto_transfer_details(&args.mentioned),
                });
                state.push_notification(users_to_notify, notification);

                handle_activity_notification(state);

                Success(SuccessResult {
                    event_index,
                    message_index,
                    timestamp: now,
                    expires_at,
                })
            }
            SendMessageResult::ThreadMessageNotFound => ThreadMessageNotFound,
            SendMessageResult::MessageEmpty => MessageEmpty,
            SendMessageResult::TextTooLong(max_length) => TextTooLong(max_length),
            SendMessageResult::InvalidPoll(reason) => InvalidPoll(reason),
            SendMessageResult::NotAuthorized => NotAuthorized,
            SendMessageResult::UserNotInGroup => UserNotInChannel,
            SendMessageResult::UserSuspended => UserSuspended,
            SendMessageResult::RulesNotAccepted => RulesNotAccepted,
            SendMessageResult::InvalidRequest(error) => InvalidRequest(error),
        }
    } else {
        ChannelNotFound
    }
}

fn register_timer_jobs(
    channel_id: ChannelId,
    thread_root_message_index: Option<MessageIndex>,
    message_event: &EventWrapper<Message>,
    now: TimestampMillis,
    timer_jobs: &mut TimerJobs<TimerJob>,
) {
    if let MessageContent::Poll(p) = &message_event.event.content {
        if let Some(end_date) = p.config.end_date {
            timer_jobs.enqueue_job(
                TimerJob::EndPoll(EndPollJob {
                    channel_id,
                    thread_root_message_index,
                    message_index: message_event.event.message_index,
                }),
                end_date,
                now,
            );
        }
    }

    let files = message_event.event.content.blob_references();
    if !files.is_empty() {
        if let Some(expiry) = message_event.expires_at {
            timer_jobs.enqueue_job(TimerJob::DeleteFileReferences(DeleteFileReferencesJob { files }), expiry, now);
        }
    }
}
