# Xiaohongshu public notes · experimental

Pass one original App share (including its text), an xhslink.cn / xhslink.com short link, or an official explore/<id> or discovery/item/<id> URL. This adapter is native and anonymous, independent of the Evil0ctal installation. No browser, Cookie, proxy rotation or login is used. It requests only HTTPS, validates redirect destinations and public IPs, and retains neither share parameters nor CDN URLs in reported metadata.

```sh
media-lens doctor --platform xiaohongshu   # local tools; does not check whether a note opens
media-lens identify "$SHARE"               # note ID and a clean citation URL, not its visibility/type
media-lens resolve "$SHARE"                # public note metadata if the original share is readable
media-lens analyze "$SHARE"                # real video frames/transcript or ordered still pages/OCR
```

The native resolver consumes data from the requested note's official guest HTML, without executing page scripts. It checks the note ID, reads an advertised H.264 MP4 or static album pages from scoped Xiaohongshu CDNs and uses the existing local processing limits. A video poster, Open Graph preview or a written caption cannot substitute for video or album evidence. The public caption (if present) is separate from the transcript and OCR. Playback files are transient by default. This slice does not implement creator profiles, motion photos or authenticated access.

| Response | Meaning |
|---|---|
| IDENTITY_LOGIN_REQUIRED | The platform requested login; no account is used. |
| UPSTREAM_RISK_CONTROL / RATE_LIMITED | Verification, access refusal or rate limit; stop. |
| XHS_SHARE_UNAVAILABLE / XHS_NOTE_UNAVAILABLE | This share did not yield the requested public note. Deletion and privacy cannot be inferred. |
| MEDIA_WITHHELD | The requested note has metadata but no complete supported video or still-image set. |

On 2026-11-09 an App short link for a recruitment-themed note resolved to a note ID and then to a login page. Older independent shares led to the homepage/login or an official error page. No live frames or caption were obtained. The [adapter tests](../../tests/xiaohongshu.test.ts) use controlled guest HTML and generated media to verify both decoding paths; that is not a successful live media test. The desktop and mobile state shapes are also documented in the [ReaJason/xhs client](https://github.com/ReaJason/xhs/blob/master/xhs/core.py) and [media-parser source](https://github.com/ucmao/media-parser/blob/main/src/parsers/xiaohongshu_parser.py). A positive acceptance requires actual JPEGs read through MCP from a guest-readable source.
