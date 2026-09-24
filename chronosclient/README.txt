Chronos Client - HTML wireframe
================================

What this is
------------
Plain, multi-page HTML wireframe of the Selah Head Spa customer-facing
booking site (byChronos "client end"), built from the reference screenshots
in D:\git\zhu\paas\ClientEnd. Structural wireframe only - not final visual
design. Bootstrap 5 + jQuery, all vendored locally (no CDN / no internet
required to view it).

How to browse it
-----------------
Open index.html for a clickable list of every page, or open
01-business-overview.html directly to start at the beginning of the flow.
If IIS is set up (see below), browse to the site's local URL instead of
opening files directly - relative links behave the same either way since
this project uses plain relative paths throughout.

Folder layout
-------------
  01-...18-*.html   One file per screen, numbered in booking/account flow
                     order. Each file is fully self-contained: the header/
                     nav markup is duplicated at the top of every page
                     (no server-side includes), so any single file can be
                     opened and read on its own.
  index.html         Dev-only sitemap listing every page. Not part of the
                     real app - delete once you don't need it anymore.
  css/site.css        Shared styles (colors, buttons, cards, header
                     variants). Colors are an approximate read of the
                     screenshots - correct the exact hex values by hand.
  js/site.js          Small jQuery interactions (toggle password visibility,
                     select a service, expand/collapse guest summary rows,
                     reschedule modal hand-off). No real backend - nothing
                     is actually saved or validated.
  vendor/            Local copies of Bootstrap 5.3.3, Bootstrap Icons 1.11.3,
                     and jQuery 3.7.1.

Notes for your manual correction pass
--------------------------------------
- Search each file for "VERIFY" HTML comments - these flag spots where a
  screenshot was small/blurry/cut off, or where source data looked like a
  possible typo, and my reading may not be exact.
- Two source screenshots (googlemap.png, longaddress.png) are Google Maps'
  own website, not our app - they were intentionally not turned into pages.
- A few source screenshots were duplicates/aliases of another page
  (moreinfo.png = selahheadspa.png, paymentmethods.png = profile.png) and
  were not built twice - see the HTML comments at the top of each file for
  exactly which screenshots each page covers.
