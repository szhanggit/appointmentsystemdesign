Fresha Client - HTML wireframe
================================

What this is
------------
Plain, multi-page HTML wireframe of Fresha's own customer-facing mobile app
(reference/inspiration source, not byChronos), built from the screenshots in
D:\git\zhu\paas\FreshaClient. Structural wireframe only - not final visual
design. Phone-width layout (narrow centered column with a fixed bottom tab
bar), matching the real app's proportions. Bootstrap 5 + jQuery, all
vendored locally (no CDN / no internet required to view it).

How to browse it
-----------------
Open index.html for a clickable list of every page, or open 01-home.html
directly to start at the app's home tab.

Folder layout
-------------
  01-...47-*.html   One file per screen, numbered by flow area. Each file
                     is fully self-contained: header/tab markup is
                     duplicated at the top of every page (no server-side
                     includes), so any single file can be opened and read
                     on its own.
  index.html         Dev-only sitemap listing every page. Delete once you
                     don't need it anymore.
  css/site.css        Shared styles: phone-frame width, bottom tab bar,
                     cards, buttons, date/time pickers. Colors are an
                     approximate read of the screenshots - correct the
                     exact hex values by hand.
  js/site.js          Small jQuery interactions (date/time pill selection,
                     service +/check toggle, heart/favourite toggle). No
                     real backend - nothing is actually saved.
  vendor/            Local copies of Bootstrap 5.3.3, Bootstrap Icons
                     1.11.3, and jQuery 3.7.1 (separate copy from
                     chronosclient's vendor folder, so this project stays
                     self-contained).

Notes for your manual correction pass
--------------------------------------
- Search each file for "VERIFY" HTML comments - these flag spots where a
  screenshot was small/blurry/cut off, where source data looked like a
  possible mismatch (e.g. servicedetail.png's content vs. what notes.txt
  says triggers it), or where no explicit next screen was captured in the
  source and I picked the most reasonable reused page instead.
- A handful of screens are genuine duplicates in the source (e.g.
  Klarna.png/Klarna3.png, selectAPackage.png/selectAPackage3.png,
  reviewandcontinue.png/reviewandcontinue2.png) and were built once, not
  twice - see each file's top comment for exactly which screenshots it
  covers.
- Sample data is NOT end-to-end consistent across every flow (e.g. the
  package-purchase numbers differ from the group-booking numbers) because
  the source screenshots themselves are separate demo runs, not one
  continuous user journey. Each page replicates its own screenshot's data
  faithfully rather than inventing cross-page consistency.
