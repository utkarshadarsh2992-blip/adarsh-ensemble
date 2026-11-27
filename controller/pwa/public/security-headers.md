# Security headers

The static build includes a restrictive CSP, Referrer-Policy, Permissions-Policy, and a frame-breaker. `frame-ancestors` is not in the meta tag (browsers ignore it there and log an error), but browsers only enforce it when delivered as an HTTP response header. The hosting layer should emit the equivalent response headers (especially `Content-Security-Policy: ...; frame-ancestors 'none'`) at publish time.
