# A platform download can redirect to a different media CDN

A save-enabled public video resolved successfully, but transfer returned UNSAFE_URL. Its official download address redirected through a Douyin video CDN to a 32-character hexadecimal subdomain of v.smtcdns.com. Inspect only hop hostnames during diagnosis; signed paths and queries can carry credentials.

The downloader admits that edge shape only on a stream redirect from an HTTPS douyinvod.com subdomain. It checks the destination IP at each hop and pins it for TLS. Initial URLs, share pages, unrelated referrers, suffix lookalikes and HTTP remain outside the rule. A second run obtained the 768,272-byte playable file. Verified twice on one post. Other CDN domains require independent evidence.

[Redirect validation](../../../packages/core/network.ts) · [boundary tests](../../../tests/provider.test.ts).

Two stored tasks failed at the same Douyin CDN with HTTP 403. A later public full-length sample also returned 403 on the old path, then completed on a new resolve with the fixed public Referer (no alternate needed). Because both the signature and request headers can change, this does not isolate the cause. [Transport fixtures](../../../tests/public-http.test.ts) separately verify header removal on redirects, same-rendition alternatives, a bounded refresh, duplicate rejection and authority/permission boundaries. Do not apply this behavior to provider-level refusals, pages or other platforms.
