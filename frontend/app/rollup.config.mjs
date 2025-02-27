/* eslint-disable no-undef */
import svelte from "rollup-plugin-svelte";
import sveltePreprocess from "svelte-preprocess";
import commonjs from "@rollup/plugin-commonjs";
import html from "@rollup/plugin-html";
import resolve from "@rollup/plugin-node-resolve";
import copy from "rollup-plugin-copy";
import livereload from "rollup-plugin-livereload";
import { terser } from "rollup-plugin-terser";
import typescript from "@rollup/plugin-typescript";
import dfxJson from "../../dfx.json" assert { type: "json" };
import inject from "rollup-plugin-inject";
import dev from "rollup-plugin-dev";
import json from "@rollup/plugin-json";
import analyze from "rollup-plugin-analyzer";
import filesize from "rollup-plugin-filesize";
import styles from "rollup-plugin-styles";
import autoprefixer from "autoprefixer";
import { sha256 } from "js-sha256";
import dotenv from "dotenv";
import replace from "@rollup/plugin-replace";
import fs from "fs-extra";
import path from "path";
import rimraf from "rimraf";
import { fileURLToPath } from "url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(dirname, "../.env") });

const dfxNetwork = process.env.DFX_NETWORK;

console.log("DFX_NETWORK: ", dfxNetwork);

if (dfxNetwork) {
    const dfxJsonPath = path.join(dirname, "../..", "dfx.json");
    const dfxJson = JSON.parse(fs.readFileSync(dfxJsonPath));
    const canisterPath =
        dfxJson["networks"][dfxNetwork]["type"] === "persistent"
            ? path.join(dirname, "../..", "canister_ids.json")
            : path.join(dirname, "../..", ".dfx", dfxNetwork, "canister_ids.json");

    if (fs.existsSync(canisterPath)) {
        const canisters = JSON.parse(fs.readFileSync(canisterPath));
        process.env.USER_INDEX_CANISTER = canisters.user_index[dfxNetwork];
        process.env.GROUP_INDEX_CANISTER = canisters.group_index[dfxNetwork];
        process.env.NOTIFICATIONS_CANISTER = canisters.notifications_index[dfxNetwork];
        process.env.ONLINE_CANISTER = canisters.online_users[dfxNetwork];
        process.env.PROPOSALS_BOT_CANISTER = canisters.proposals_bot[dfxNetwork];
        process.env.STORAGE_INDEX_CANISTER = canisters.storage_index[dfxNetwork];
        process.env.REGISTRY_CANISTER = canisters.registry[dfxNetwork];
        process.env.MARKET_MAKER_CANISTER = canisters.market_maker[dfxNetwork];

        console.log("UserIndexCanisterId: ", process.env.USER_INDEX_CANISTER);
        console.log("GroupIndexCanisterId: ", process.env.GROUP_INDEX_CANISTER);
        console.log("NotificationsCanisterId: ", process.env.NOTIFICATIONS_CANISTER);
        console.log("OnlineCanisterId: ", process.env.ONLINE_CANISTER);
        console.log("ProposalsBotCanisterId: ", process.env.PROPOSALS_BOT_CANISTER);
        console.log("StorageIndex: ", process.env.STORAGE_INDEX_CANISTER);
        console.log("Registry: ", process.env.REGISTRY_CANISTER);
        console.log("MarketMaker: ", process.env.MARKET_MAKER_CANISTER);
    } else {
        console.log(
            "Couldn't find canisters JSON at: ",
            canisterPath,
            ". Falling back to original env vars."
        );
    }
} else {
    console.log(
        "DFX_NETWORK env var not set, cannot load correct canisterIds, falling back to original env vars."
    );
}

const production = !process.env.ROLLUP_WATCH;
const env = process.env.NODE_ENV ?? (production ? "production" : "development");
const version = process.env.OPENCHAT_WEBSITE_VERSION;
if (production && !version) {
    throw Error("OPENCHAT_WEBSITE_VERSION environment variable not set");
}
if (production && !process.env.ROLLBAR_ACCESS_TOKEN) {
    throw Error("ROLLBAR_ACCESS_TOKEN environment variable not set");
}
if (production && !process.env.USERGEEK_APIKEY) {
    throw Error("USERGEEK_APIKEY environment variable not set");
}
if (production && !process.env.METERED_APIKEY) {
    throw Error("METERED_APIKEY environment variable not set");
}
const WEBPUSH_SERVICE_WORKER_PATH = "/_/raw/push_sw.js";

console.log("PROD", production);
console.log("ENV", env);
console.log("INTERNET IDENTITY URL", process.env.INTERNET_IDENTITY_URL);
console.log("NFID URL", process.env.NFID_URL);
console.log("VERSION", version ?? "undefined");

function serve() {
    return dev({
        dirs: ["./build", "./public"],
        proxy: [
            {
                from: "/api/*",
                to: `http://${dfxJson.networks.local.bind}`,
            },
        ],
        spa: "./index.html",
        port: process.env.DEV_PORT || 5000,
    });
}

function copyFile(fromPath, toPath, file) {
    const from = path.join(dirname, fromPath, file);
    const to = path.join(dirname, toPath, file);
    if (fs.existsSync(from)) {
        console.log("Copying file -> : ", from, to);
        fs.copySync(from, to, {
            recursive: true,
        });
    }
}

// this is a bit ridiculous but there we are ...
function clean() {
    return {
        name: "clean-build",
        renderStart() {
            console.log("cleaning up the build directory");
            rimraf.sync(path.join(dirname, "build"));
            fs.mkdirSync("build");
            if (version) {
                fs.writeFileSync("build/version", JSON.stringify({ version }));
            }
            const customDomains = process.env.CUSTOM_DOMAINS;
            if (customDomains !== undefined) {
                fs.mkdirSync("build/.well-known");
                fs.writeFileSync(
                    "build/.well-known/ii-alternative-origins",
                    JSON.stringify({
                        alternativeOrigins: customDomains.split(",").map((d) => `https://${d}`),
                    })
                );
                fs.writeFileSync(
                    "build/.well-known/ic-domains",
                    customDomains.split(",").join("\n")
                );
            }
            copyFile(".", "build", ".ic-assets.json5");
        },
    };
}

// Put external dependencies into their own bundle so that they get cached separately
function manualChunks(id) {
    if (id.includes("node_modules") || id.includes("vendor-")) {
        return "vendor";
    }
}

function transformSourceMappingUrl(contents) {
    return contents
        .toString()
        .replace("//# sourceMappingURL=", "//# sourceMappingURL=./_/raw/");
}

export default {
    input: `./src/main.ts`,
    output: {
        sourcemap: true,
        format: "es",
        name: "app",
        dir: "build",
        entryFileNames: "[name]-[hash].js",
        manualChunks,
    },
    plugins: [
        clean(),
        svelte({
            preprocess: sveltePreprocess({
                sourceMap: !production,
                scss: {
                    prependData: `@use 'sass:math'; @import 'src/styles/mixins.scss';`,
                },
            }),
            compilerOptions: {
                dev: !production,
                // immutable: true, // this could be a great optimisation, but we need to plan for it a bit
            },
            onwarn: (warning, handler) => {
                if (warning.code.startsWith("a11y-")) return;
                handler(warning);
            },
        }),

        styles({ mode: "extract", plugins: [autoprefixer()] }),

        resolve({
            preferBuiltins: false,
            browser: true,
            dedupe: ["svelte"],
        }),
        commonjs(),
        typescript({
            sourceMap: !production,
            inlineSources: !production,
        }),
        inject({
            Buffer: ["buffer", "Buffer"],
            process: "process/browser",
        }),
        json(),

        replace({
            preventAssignment: true,
            "process.env.INTERNET_IDENTITY_URL": JSON.stringify(process.env.INTERNET_IDENTITY_URL),
            "process.env.NFID_URL": JSON.stringify(process.env.NFID_URL),
            "process.env.DFX_NETWORK": JSON.stringify(dfxNetwork),
            "process.env.NODE_ENV": JSON.stringify(env),
            "process.env.OPENCHAT_WEBSITE_VERSION": JSON.stringify(version),
            "process.env.ROLLBAR_ACCESS_TOKEN": JSON.stringify(process.env.ROLLBAR_ACCESS_TOKEN),
            "process.env.IC_URL": maybeStringify(process.env.IC_URL),
            "process.env.II_DERIVATION_ORIGIN": maybeStringify(process.env.II_DERIVATION_ORIGIN),
            "process.env.USER_INDEX_CANISTER": JSON.stringify(process.env.USER_INDEX_CANISTER),
            "process.env.GROUP_INDEX_CANISTER": JSON.stringify(process.env.GROUP_INDEX_CANISTER),
            "process.env.NOTIFICATIONS_CANISTER": JSON.stringify(
                process.env.NOTIFICATIONS_CANISTER
            ),
            "process.env.ONLINE_CANISTER": JSON.stringify(process.env.ONLINE_CANISTER),
            "process.env.PROPOSALS_BOT_CANISTER": JSON.stringify(
                process.env.PROPOSALS_BOT_CANISTER
            ),
            "process.env.STORAGE_INDEX_CANISTER": JSON.stringify(
                process.env.STORAGE_INDEX_CANISTER
            ),
            "process.env.REGISTRY_CANISTER": JSON.stringify(process.env.REGISTRY_CANISTER),
            "process.env.MARKET_MAKER_CANISTER": JSON.stringify(process.env.MARKET_MAKER_CANISTER),
            "process.env.LEDGER_CANISTER_ICP": JSON.stringify(process.env.LEDGER_CANISTER_ICP),
            "process.env.LEDGER_CANISTER_SNS1": JSON.stringify(process.env.LEDGER_CANISTER_SNS1),
            "process.env.LEDGER_CANISTER_BTC": JSON.stringify(process.env.LEDGER_CANISTER_BTC),
            "process.env.LEDGER_CANISTER_CHAT": JSON.stringify(process.env.LEDGER_CANISTER_CHAT),
            "process.env.LEDGER_CANISTER_KINIC": JSON.stringify(process.env.LEDGER_CANISTER_KINIC),
            "process.env.LEDGER_CANISTER_HOTORNOT": JSON.stringify(
                process.env.LEDGER_CANISTER_HOTORNOT
            ),
            "process.env.LEDGER_CANISTER_GHOST": JSON.stringify(process.env.LEDGER_CANISTER_GHOST),
            "process.env.BLOB_URL_PATTERN": JSON.stringify(process.env.BLOB_URL_PATTERN),
            "process.env.USERGEEK_APIKEY": JSON.stringify(process.env.USERGEEK_APIKEY),
            "process.env.METERED_APIKEY": JSON.stringify(process.env.METERED_APIKEY),
            "process.env.GIPHY_APIKEY": JSON.stringify(process.env.GIPHY_APIKEY),
            "process.env.CORS_APIKEY": JSON.stringify(process.env.CORS_APIKEY),
            "process.env.PUBLIC_TRANSLATE_API_KEY": JSON.stringify(
                process.env.PUBLIC_TRANSLATE_API_KEY
            ),
            "process.env.WEBPUSH_SERVICE_WORKER_PATH": WEBPUSH_SERVICE_WORKER_PATH,
            "process.env.FRAME_ANCESTORS": JSON.stringify(process.env.FRAME_ANCESTORS),
        }),

        html({
            template: ({ files }) => {
                const jsEntryFile = files.js.find((f) => f.isEntry).fileName;

                function generateCspHashValue(text) {
                    const hash = sha256.update(text).arrayBuffer();
                    const base64 = Buffer.from(hash).toString("base64");
                    return `'sha256-${base64}'`;
                }

                const inlineScripts = [
                    `window.OPENCHAT_WEBSITE_VERSION = "${version}";`,
                    `var parcelRequire;`,
                ];
                const cspHashValues = inlineScripts.map(generateCspHashValue);
                let csp = `
                    style-src * 'unsafe-inline'; 
                    style-src-elem * 'unsafe-inline';
                    font-src 'self' https://fonts.gstatic.com/;
                    object-src 'none';
                    base-uri 'self';
                    form-action 'self';
                    upgrade-insecure-requests;
                    script-src 'self' 'unsafe-eval' https://api.rollbar.com/api/ https://platform.twitter.com/ https://www.googletagmanager.com/ ${cspHashValues.join(
                        " "
                    )}`;
                if (!production) {
                    csp += " http://localhost:* http://127.0.0.1:*";
                }

                return `
                        <!DOCTYPE html>
                        <html lang="en">
                            <head>
                            <!-- Google tag (gtag.js) -->
                                <script async src="https://www.googletagmanager.com/gtag/js?id=G-7P9R6CJLNR"></script>
                                <script>
                                    window.dataLayer = window.dataLayer || [];
                                    function gtag(){dataLayer.push(arguments);}
                                    gtag('js', new Date());
                                    gtag('config', 'G-7P9R6CJLNR');
                                </script>
                                <meta name="theme-color" media="(prefers-color-scheme: light)" content="#22A7F2" />
                                <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1B1C21" />
                                <meta name="description" content="OpenChat is a fully featured chat application running end-to-end on the Internet Computer blockchain." />
                                <meta property="og:title" content="OpenChat">
                                <meta property="og:type" content="website" />
                                <meta property="og:description" content="OpenChat is a fully featured chat application running end-to-end on the Internet Computer blockchain.">
                                <meta property="og:image" content="https://oc.app/assets/share-oc-light.png">
                                <meta name="twitter:image" content="https://oc.app/assets/share-oc-light.png">
                                <meta property="og:url" content="https://oc.app">
                                <meta name="twitter:card" content="summary_large_image">
                                <meta property="og:site_name" content="OpenChat">
                                <meta name="twitter:image:alt" content="OpenChat is a fully featured chat application running end-to-end on the Internet Computer blockchain.">
                                <meta http-equiv="Content-Security-Policy" content="${csp}" />
                                <meta charset="utf-8" />
                                <meta name="viewport" content="width=device-width, initial-scale=1">
                                <meta name="apple-mobile-web-app-title" content="OpenChat" />
                                <meta name="twitter:widgets:autoload" content="off">
                                <meta name="twitter:dnt" content="on">
                                <meta name="twitter:widgets:csp" content="on">
                                <link rel="canonical" href="/">
                                <title>OpenChat</title>
                                <link rel="manifest" href="/openchat.webmanifest" />
                                <link rel="apple-touch-startup-image" href="/_/raw/apple-touch-icon.png" />
                                <link rel="apple-touch-icon" href="/_/raw/apple-touch-icon.png" />
                                <link rel="icon" type="image/png" href="/icon.png" />
                                <link rel="preconnect" href="https://fonts.googleapis.com" />
                                <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
                                <link
                                    href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Bebas+Neue&family=Manrope:wght@400;500;700&family=Roboto:wght@200;300;400;700&display=swap"
                                    rel="stylesheet"
                                />
                                <script type="module" src="https://platform.twitter.com/widgets.js"></script>
                                <script type="module" defer src="/${jsEntryFile}"></script>
                                ${files.css
                                    .map((f) => `<link rel="stylesheet" href="/${f.fileName}" />`)
                                    .join("")}
                                ${inlineScripts.map((s) => `<script>${s}</script>`).join("")}
                            </head>
                            <body></body>
                        </html>
                    `;
            },
        }),

        // In dev mode, call `npm run start` once
        // the bundle has been generated
        !production && serve(),

        // Watch the `public` directory and refresh the
        // browser on changes when not in production
        !production && livereload("build"),

        // If we're building for production (npm run build
        // instead of npm run dev), minify
        production && terser(),

        production && analyze({ summaryOnly: true }),

        production && filesize(),

        // Pull in the worker and push_sw
        copy({
            targets: [{
                src: "../openchat-worker/lib/*",
                dest: "build",
            }, {
                src: "../openchat-push/lib/*",
                dest: "build/_/raw",
                transform: transformSourceMappingUrl,
            }],
            hook: "generateBundle",
        }),

        // Copy source maps to '_/raw' so that they can be loaded without going through the certifying service worker
        copy({
            targets: [{
                src: "build/*.map",
                dest: "build/_/raw",
            }, {
                src: "build/*.js",
                dest: "build",
                transform: transformSourceMappingUrl,
            }],
            hook: "writeBundle",
        }),
    ],
    watch: {
        clearScreen: false,
    },
};

function maybeStringify(value) {
    return value !== undefined ? JSON.stringify(value) : undefined;
}
