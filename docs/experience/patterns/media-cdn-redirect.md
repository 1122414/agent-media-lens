# A platform download can redirect to a different media CDN

A save-enabled public video resolved successfully, but transfer returned UNSAFE_URL. Its official download address redirected through a Douyin video CDN to a 32-character hexadecimal subdomain of v.smtcdns.com. Inspect only hop hostnames during diagnosis; signed paths and queries can carry credentials.

The downloader admits that edge shape only on a stream redirect from an HTTPS douyinvod.com subdomain. It checks the destination IP at each hop and pins it for TLS. Initial URLs, share pages, unrelated referrers, suffix lookalikes and HTTP remain outside the rule. A second run obtained the 768,272-byte playable file. Verified twice on one post. Other CDN domains require independent evidence.

[Redirect validation](../../../packages/core/network.ts) · [boundary tests](../../../tests/provider.test.ts).
