# Gate read egress

The gate process starts the internal `startEgressProxy` listener on `127.0.0.1` with a configurable port. The returned `baseUrl` is the client-facing address; send requests to `/` with `X-Eido-Connector` naming the pinned connector and `X-Eido-Target` containing the absolute HTTPS target URL. Use the upstream method, headers and body. Caller credentials and hop-by-hop headers are stripped. Only the gate reads the vault; connectors never receive tokens.

HTTP operations must pin optional `routes` entries (`host`, `method`, `pathPattern`) on each operation. Patterns match the entire path; `{parameter}` matches exactly one nonempty segment. They remain constrained by the connector's existing host, method and literal path-prefix allowlist. Existing manifests without routes continue to validate but cannot use HTTP egress until a new reviewed manifest version pins routes. Any matching write operation makes the request fail, including overlaps with read routes.

Only HTTPS default-port targets are accepted. Dot segments (checked before URL normalization), encoded slashes, repeated percent encoding, backslashes, URL credentials and fragments are refused. Redirects are never followed. This listener is a loopback internal service; host exposure and client authentication belong to the process/network boundary.

The default body limit is 8 MiB in each direction and the request deadline is 30 seconds, configurable at startup. Upstream bodies are consumed in bounded chunks and inspected before response headers are released, so oversized responses and upstream credential echoes return 502 without partial secret disclosure. Only content type is returned from upstream headers; response caching is disabled. Large downloads need a separately reviewed transport rather than an unbounded pass-through.

Each refusal records `egress_refused` with a hashed reason. Each completed upstream response records `egress_allowed` with hashed method, host, pinned path template and status. No query values, body data, header values or upstream error messages enter the audit log. A 401 revokes the grant through the vault revocation path, disables the connector and clears cached access tokens.

The browser edge in [#178](https://github.com/mgwedd/eido/issues/178) uses Tailscale Serve for Next, the core API, and the separate phone gate listener. This outbound data-plane proxy is never mounted by Serve. It remains separate from the Unix-socket intent listener (#42), phone listener (#85), and local admin surface (#78).
