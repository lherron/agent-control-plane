# Interfaces and gateways

## Sub-features

Discord ingress/replies/lifecycle cards, mobile auth/history/timeline, interface bindings/delivery attachments, conversation threads.

Source anchors (repo-relative): packages/gateway-discord/src; packages/gateway-ios/src/routes.ts; packages/acp-server/src/routing. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `cli:acp admin interface []`
- Surface: `cli:acp admin interface binding []`
- Surface: `cli:acp admin interface binding disable [--actor --conversation-ref --gateway --json --server --thread-ref]`
- Surface: `cli:acp admin interface binding lint [--actor --all --gateway --json --project --server --show-ok]`
- Surface: `cli:acp admin interface binding list [--actor --conversation-ref --gateway --gateway-type --json --project --server --thread-ref]`
- Surface: `cli:acp admin interface binding set [--actor --conversation-ref --gateway --gateway-type --json --lane-ref --project --scope-ref --server --session --thread-ref]`
- Surface: `cli:acp delivery []`
- Surface: `cli:acp delivery list-failed [--actor --gateway --json --limit --project --server --since --table]`
- Surface: `cli:acp delivery retry [--actor --delivery --json --project --requeued-by --server --table]`
- Surface: `cli:acp interface []`
- Surface: `cli:acp interface identity []`
- Surface: `cli:acp interface identity register [--actor --display-name --external-id --gateway --json --linked-agent --server]`
- Surface: `cli:acp mobile []`
- Surface: `cli:acp mobile auth []`
- Surface: `cli:acp mobile auth disable [--actor --json --server --table]`
- Surface: `cli:acp mobile auth enable [--actor --force --json --server --table]`
- Surface: `cli:acp mobile auth status [--actor --json --server --table]`
- Surface: `cli:acp mobile devices []`
- Surface: `cli:acp mobile devices list [--actor --json --server --table]`
- Surface: `cli:acp mobile devices revoke [--actor --device --json --server --table]`
- Surface: `cli:acp mobile pairing-code [--actor --json --server --table]`
- Surface: `cli:acp thread []`
- Surface: `cli:acp thread list [--actor --json --lane-ref --project --scope-ref --server --table]`
- Surface: `cli:acp thread show [--actor --json --server --table --thread]`
- Surface: `cli:acp thread turns [--actor --json --limit --server --since --table --thread]`
- Surface: `package:acp-conversation`
- Surface: `package:acp-interface-store`
- Surface: `package:gateway-discord`
- Surface: `package:gateway-ios`
- Surface: `route:GET /v1/admin/interface-identities @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/conversation/threads @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/conversation/threads/:threadId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/conversation/threads/:threadId/turns @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/interface/bindings @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/mobile/auth/devices @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/mobile/dashboard @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/mobile/dm/targets @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/mobile/health @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/mobile/history @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/mobile/messages/watch @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/mobile/pairing @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/mobile/sessions/:hostSessionId/attach-info @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/plugins/events @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/plugins/events/tail @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v2/mobile/dashboard @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v2/mobile/sessions @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/admin/interface-identities @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/gateway/deliveries/:deliveryRequestId/ack @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/gateway/deliveries/:deliveryRequestId/fail @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/gateway/deliveries/:deliveryRequestId/requeue @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/interface/bindings @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/interface/messages @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/auth/devices/revoke @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/auth/enforce @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/auth/pairing-code @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/messages/dm @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/messages/query @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/pair @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/sessions @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/sessions/:hostSessionId/input @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/mobile/sessions/:hostSessionId/interrupt @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/mobile/sessions/:hostSessionId/restart @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/plugins/events/resolve-cursor @ packages/acp-server/src/routing/exact-routes.ts`

- Surface: `cli:acp run attachment []`
- Surface: `cli:acp run attachment add [--actor --alt --content-type --filename --json --project --run --server]`
- Surface: `cli:acp run attachment clear [--actor --json --project --run --server]`
- Surface: `cli:acp run attachment list [--actor --json --project --run --server]`
- Surface: `route:GET /v1/gateway/:gatewayId/deliveries/stream @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/gateway/deliveries @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/health @ packages/gateway-ios/src/routes.ts`
- Surface: `route:GET /v1/history @ packages/gateway-ios/src/routes.ts`
- Surface: `route:GET /v1/runs/:runId/outbound-attachments @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/sessions @ packages/gateway-ios/src/routes.ts`
- Surface: `route:POST /v1/input @ packages/gateway-ios/src/routes.ts`
- Surface: `route:POST /v1/interrupt @ packages/gateway-ios/src/routes.ts`
- Surface: `route:POST /v1/runs/:runId/outbound-attachments @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/runs/:runId/outbound-messages @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/sessions/refresh @ packages/gateway-ios/src/routes.ts`

## How to get to it

Use `bun scripts/discover-acp.ts routes mobile`, `acp admin interface binding --help`, and the owned server URL printed by dev-env.

## Driving it

Scratch helper fetches mobile health and verifies an unknown HTTP route is rejected. For mobile timeline ordering, the opt-in `bun run test:acceptance` owns isolated real HRC/wrkq/ACP, writes var/e2e-reports/mobile-timeline-ordering.json, and needs non-loopback IPv4 plus wrkf/wrkqadm. Read its source before running. Discord requires an approved real channel/credentials drive; this task does not send messages.

## Gotchas

Health is not history/timeline or bearer-auth proof. Source fake-client tests are not Discord smoke. Never reuse live bindings, bot tokens, pairing state, delivery requests or production jobs. The dev-env scratch acp-server does not set `ACP_MOBILE_AUTH_PATH`, so it resolves the live `var/state/acp-server/mobile-auth.json`; never run `acp mobile auth|devices|pairing-code` or bearer requests against it. Only the acceptance fixture isolates mobile auth. `binding disable` rewrites the stored `gatewayType` to `unknown` (observed T-11918); do not read gateway type from a disabled binding. The acceptance gate was documented with an open campaign defect but exited 0 (13/13) on T-11918; report the actual exit.

## Proven when

Health response and route rejection recorded by scratch helper prove HTTP plumbing only. Mobile bearer/history/WS, Discord, bindings and outbound attachments remain manually undriven until their actual path and failure responses are captured.
