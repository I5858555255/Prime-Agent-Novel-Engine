# Prime Agent cloud-daemon image

The container image a Prime Agent Swarm cloud agent runs inside a Prime Sandbox.
It bakes the prime-agent daemon and starts it in daemon mode. The platform
references this image via its `PRIME_AGENT_SANDBOX_IMAGE` setting.

## Build & publish

```bash
docker/agent-daemon/build.sh [image-tag]
# e.g.
PRIME_AGENT_IMAGE=registry.example.com/prime-agent-daemon:<sha> docker/agent-daemon/build.sh
docker push <image-tag>
```

`build.sh` compiles the bundle (`npm run build`) and assembles the image from it,
so the image always matches this checkout's daemon code.

## Runtime environment

The daemon adapts to whatever the platform injects; nothing is required to run
locally. As a cloud agent the platform provides:

| Env var | Purpose |
|---|---|
| `ORCHESTRATOR_URL` | Backend base URL for `/daemon/heartbeat` + `/daemon/status` |
| `PRIME_AGENT_ID` | Agent id (token audience check) |
| `PRIME_AGENT_BOOTSTRAP_TOKEN` | Authenticates the daemon's reports to the backend |
| `PRIME_AGENT_DAEMON_PORT` | Port the connect listener binds (exposed by the platform) |
| `PRIME_AGENT_CONNECT_PUBLIC_KEY` | Public key used to verify connect tokens |

With these set the daemon reports status + heartbeats and serves the
token-authenticated connect channel; with none set it just runs locally on its
unix socket.
