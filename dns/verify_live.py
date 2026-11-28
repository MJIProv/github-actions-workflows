#!/usr/bin/env python3
"""Read-only check that yendra-c.com is live on Cloudflare. No credentials, stdlib only.

    python3 dns/verify_live.py            # exit 0 = every check passed

Uses RDAP (registry), DNS-over-HTTPS (1.1.1.1 and 8.8.8.8 as seen on the public internet) and plain HTTPS.
Raw port-53 DNS is NOT used: some sandboxes intercept it and give false answers.
Limits: behind a TLS-intercepting egress proxy the certificate seen here is the proxy's, so the
script says so instead of judging it. Check the certificate in a browser or from an unproxied machine.
"""
import json, os, re, socket, ssl, sys, urllib.error, urllib.request

DOMAIN = os.environ.get("VERIFY_DOMAIN", "yendra-c.com")
PAGES = os.environ.get("VERIFY_PAGES", "yendra-website.pages.dev")   # the Pages project that should be serving the site
fails = 0

def row(status, name, detail=""):
    global fails
    if status == "FAIL":
        fails += 1
    print(f"{status:5} {name}" + (f"  -- {detail}" if detail else ""))

def get_json(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers=headers or {})
    return json.load(urllib.request.urlopen(req, timeout=timeout))

def doh(resolver, name, rtype):
    base = {"cf": "https://cloudflare-dns.com/dns-query", "g": "https://dns.google/resolve"}[resolver]
    return get_json(f"{base}?name={name}&type={rtype}", {"accept": "application/dns-json"})

def answers(resolver, name, rtype):
    d = doh(resolver, name, rtype)
    return d.get("Status"), bool(d.get("AD")), [a["data"].strip('"') for a in d.get("Answer", []) if a.get("type") in (1, 5, 15, 16, 2, 43, 28)]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None

def fetch(url, follow=True, timeout=20):
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        r = opener.open(urllib.request.Request(url, headers={"user-agent": "yendra-c-verify/1"}), timeout=timeout)
        return r.status, dict(r.headers), r.read(2_000_000), r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(200_000), url
    except Exception as e:
        return None, {"error": str(e)[:100]}, b"", url

def title(body):
    m = re.search(rb"<title[^>]*>(.*?)</title>", body, re.I | re.S)
    return m.group(1).decode(errors="replace").strip() if m else ""

def registrar_name(d):
    """Cosmetic only: never let an odd RDAP vCard shape fail the run."""
    try:
        for e in d.get("entities", []):
            if "registrar" in e.get("roles", []):
                for prop in e["vcardArray"][1]:
                    if prop[0] == "fn":
                        return str(prop[3])
    except (KeyError, IndexError, TypeError):
        pass
    return "?"

print(f"== {DOMAIN} live check")

# 1. Registry: registrar, nameservers, DS
try:
    d = get_json(f"https://rdap.verisign.com/com/v1/domain/{DOMAIN}")
    ns = sorted(n["ldhName"].lower() for n in d.get("nameservers", []))
    ds = d.get("secureDNS", {}).get("dsData", [])
    cf_ns = bool(ns) and all(n.endswith(".cloudflare.com") for n in ns)
    row("PASS" if cf_ns else "FAIL", "registry nameservers are Cloudflare's", ", ".join(ns))
    expected = {"junade.ns.cloudflare.com", "zainab.ns.cloudflare.com"}   # reported as the zone's pair on 27 Nov 2026; confirm on the zone Overview page
    if cf_ns:
        row("PASS" if set(ns) == expected else "INFO", "nameservers equal the pair reported for this zone", ", ".join(sorted(expected)))
    row("INFO", "registry DS records", f"{len(ds)} present" + (f" (key tags {[x.get('keyTag') for x in ds]})" if ds else ""))
    row("INFO", "registrar", registrar_name(d))
    row("INFO", "expires", next((e.get("eventDate", "?") for e in d.get("events", []) if e.get("eventAction") == "expiration"), "?"))
except Exception as e:
    row("FAIL", "registry lookup", str(e)[:100]); ns, ds, cf_ns = [], [], False

# 2. Public DNS (DoH), both resolvers must agree
for res, label in (("cf", "1.1.1.1"), ("g", "8.8.8.8")):
    try:
        st, ad, nsa = answers(res, DOMAIN, "NS")
        ok = bool(nsa) and all(x.rstrip(".").lower().endswith(".cloudflare.com") for x in nsa)
        row("PASS" if ok else "FAIL", f"public NS via {label}", ", ".join(nsa) or f"status {st}")
    except Exception as e:
        row("FAIL", f"public NS via {label}", str(e)[:80])

# 3. DNSSEC consistency: a DS at the registry with a non-signed zone makes validating resolvers fail
try:
    st_cf, ad_cf, a_cf = answers("cf", DOMAIN, "A")
    st_g, ad_g, a_g = answers("g", DOMAIN, "A")
    ok = st_cf == 0 and st_g == 0
    row("PASS" if ok else "FAIL", "apex A resolves on validating resolvers (no SERVFAIL)", f"1.1.1.1 status {st_cf}, 8.8.8.8 status {st_g}")
    row("INFO", "DNSSEC validated (AD flag)", f"1.1.1.1 {ad_cf}, 8.8.8.8 {ad_g}")
    if ds and cf_ns:
        row("INFO", "DS still at registry while on Cloudflare", "must match Cloudflare's DS or be removed")
except Exception as e:
    row("FAIL", "apex A resolution", str(e)[:80]); a_cf = []

# 4. Mail records must survive the move
try:
    _, _, mx = answers("cf", DOMAIN, "MX")
    row("PASS" if any("smtp.google.com" in m for m in mx) else "FAIL", "MX -> smtp.google.com", ", ".join(mx) or "none")
    _, _, txt = answers("cf", DOMAIN, "TXT")
    row("PASS" if any(t.startswith("v=spf1") and "_spf.google.com" in t for t in txt) else "FAIL", "SPF includes _spf.google.com")
    _, _, dk = answers("cf", f"google._domainkey.{DOMAIN}", "TXT")
    row("PASS" if any("v=DKIM1" in t for t in dk) else "FAIL", "Google DKIM present")
    _, _, dm = answers("cf", f"_dmarc.{DOMAIN}", "TXT")
    row("PASS" if any(t.startswith("v=DMARC1") for t in dm) else "INFO", "DMARC present", "; ".join(dm)[:80] or "none")
except Exception as e:
    row("FAIL", "mail records", str(e)[:80])

# 5. Website: apex and www over HTTPS, served by Cloudflare, same content as the Pages project
sp, hp, bp, up = fetch(f"https://{PAGES}/")
row("PASS" if sp == 200 else "FAIL", f"Pages project {PAGES} serves", f"HTTP {sp}, title '{title(bp)}'")
pages_title = title(bp) if sp == 200 else None   # titles, not bytes: Cloudflare may inject scripts or obfuscate mailto links on a proxied domain
for host in (DOMAIN, f"www.{DOMAIN}"):
    s, h, b, u = fetch(f"https://{host}/")
    srv = h.get("server", h.get("Server", "?"))
    row("PASS" if s == 200 else "FAIL", f"https://{host} responds", f"HTTP {s}, server {srv}")
    row("PASS" if str(srv).lower() == "cloudflare" else "FAIL", f"https://{host} is served by Cloudflare", f"server: {srv}")
    if s == 200 and pages_title:
        row("PASS" if title(b) == pages_title else "FAIL", f"https://{host} is the same page as the Pages deployment (same <title>)", f"title '{title(b)}' vs '{pages_title}'")
    row("INFO", f"https://{host} final URL", u)
s, h, _, _ = fetch(f"http://{DOMAIN}/", follow=False)
row("PASS" if s in (301, 302, 307, 308) and str(h.get("Location", h.get("location", ""))).startswith("https://") else "INFO",
    "http -> https redirect", f"HTTP {s} {h.get('Location', h.get('location', ''))}")

# 6. Certificate: only judge it if we are not behind an intercepting proxy
try:
    ctx = ssl.create_default_context()
    with socket.create_connection((DOMAIN, 443), timeout=10) as raw, ctx.wrap_socket(raw, server_hostname=DOMAIN) as tls:
        cert = tls.getpeercert()
    issuer = dict(x[0] for x in cert["issuer"]).get("organizationName", "?")
    if "anthropic" in issuer.lower():
        row("INFO", "TLS certificate", "not judged: this network intercepts TLS (issuer %s). Check it in a browser." % issuer)
    else:
        row("PASS", "TLS certificate valid for the name", f"issuer {issuer}, expires {cert['notAfter']}")
except ssl.SSLCertVerificationError as e:
    row("FAIL", "TLS certificate", f"does not verify: {getattr(e, 'verify_message', None) or str(e)[:70]}")
except Exception as e:   # network or proxy trouble: cannot judge, so say so rather than guess
    row("INFO", "TLS certificate", f"not checked ({str(e)[:70]})")

print("\nRESULT:", "ALL CHECKS PASSED" if fails == 0 else f"{fails} CHECK(S) FAILED")
sys.exit(1 if fails else 0)
