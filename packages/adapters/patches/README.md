`oblien@2.4.0.patch` carries cancellation through the SDK's log requests and
streams, and cancels the response body when a stream finishes. Without it,
closing a Cloud log view leaves idle upstream requests open indefinitely.

The adapter uses the SDK's existing HTTP transport and SSE parser. The version
is pinned until an SDK release includes this fix. Root installs apply the patch
through Bun; source releases copy the same patch and manifest entry. Bundled
desktop/native builds include the patched code.
