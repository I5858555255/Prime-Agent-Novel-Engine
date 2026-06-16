# Production image for running prime-agent as a cloud agent daemon inside a
# Prime Sandbox. Built via build.sh, which compiles the bundle and assembles a
# minimal build context (the bundle + its sibling package.json).
#
# When the platform injects ORCHESTRATOR_URL / PRIME_AGENT_* the daemon reports
# status + heartbeats to the control plane and serves the token-authenticated
# connect channel; with none of those set it simply runs locally on the unix
# socket. No wrapper/shim — the daemon does this itself.
FROM node:22-slim

WORKDIR /app

# Packages the bundler keeps external (native / interop-sensitive). Keep in
# sync with the `external` list in packages/coding-agent/scripts/bundle.mjs.
RUN npm install --no-save --no-audit --no-fund \
        zeromq koffi undici @silvia-odwyer/photon-node @mariozechner/clipboard \
    && npm cache clean --force

COPY bundle/ /app/bundle/

ENV PI_CODING_AGENT=true

CMD ["node", "/app/bundle/cli.js", "--mode", "daemon", "--daemon-socket", "/tmp/prime-agent-daemon.sock"]
