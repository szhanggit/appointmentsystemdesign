Chronos BackOffice - HTML wireframe
=====================================

What this is
------------
Plain, multi-page HTML wireframe of the byChronos staff/admin panel (the
"BackOffice" reference), built from the screenshots in
D:\git\zhu\paas\BackOffice. Structural wireframe only - not final visual
design. Desktop layout (persistent left sidebar), matching the real app.
Bootstrap 5 + jQuery + Bootstrap Icons, all vendored locally in /vendor
(no CDN / no internet required to view it - separate copy from
chronosclient's and freshaclient's vendor folders, so this project stays
self-contained).

How to browse it
-----------------
Open index.html for a clickable list of all 102 pages grouped by section,
or open 00-login.html to start at the very beginning of the flow
(Login -> Choose a location -> Home dashboard -> every menu section).

Folder layout
-------------
  00-login.html, 00-locations.html   Pre-login screens, no sidebar.
  0-home.html                         Home dashboard.
  appt-*.html                         Appointments (calendar + all 6
                                       booking-scenario detail examples).
  hist-*.html                         Appointments History.
  wait-*.html                         Waitlist.
  checkout-*.html                     Checkout / New Sale.
  sales-*.html                        Sales.
  cust-*.html                         Customers.
  inv-*.html                          Inventory (Services/Bundles/Add-ons/
                                       Products/Gift Cards/Package Cards/
                                       Rewards).
  staff-*.html                        Staffs.
  mkt-*.html                          Marketing.
  rpt-*.html                          Reports.
  bset-*.html                         Business Settings.
  lock-01-screen.html                 Lock Screen.
  index.html                          Dev-only sitemap. Delete once you
                                       don't need it anymore.
  css/site.css                        Shared styles: sidebar, cards, KPI
                                       tiles, simple inline SVG/CSS charts
                                       (no charting library). Colors are an
                                       approximate read of the screenshots -
                                       correct the exact hex values by hand.
  js/site.js                          Small jQuery interactions (password
                                       toggle, days-to-preview pill toggle,
                                       scroll-to-top). No real backend -
                                       nothing is actually saved.
  vendor/                             Local copies of Bootstrap 5.3.3,
                                       Bootstrap Icons 1.11.3, and jQuery
                                       3.7.1.

Every page's own left sidebar is duplicated in full (no server-side
includes), so any single file is fully self-contained and readable on
its own, per your earlier instructions for chronosclient/freshaclient.

Notes for your manual correction pass
--------------------------------------
- Search each file for "VERIFY" HTML comments - these flag spots where a
  screenshot was cut off, truncated (e.g. a 27-item service list shown as a
  representative sample), or where source data looked inconsistent
  (e.g. the Home dashboard's booking-quantity pie slices not quite summing
  to the labeled total).
- Business Settings' overview page (bset-01-overview.html) lists five
  items - Blacklist, Printer, Loyalty Settings, Notifications, Help Center -
  that appear in the source screenshot (BusinessSettingsDetail.png) but have
  no dedicated detail screenshot anywhere in the BackOffice folder. Their
  links are placeholders (#).
- Several screenshots are literal duplicates or near-duplicates that were
  built once and reused/aliased rather than rebuilt: e.g. Task1's Connie/Luna
  cards (group booking, same appointment viewed from each technician's
  column), Task2's Lucy/Nina cards, Task5's Eva/Ella cards (identical
  content), and EditCommissionsWithANNA.png / EditStaffCommissions.png (same
  modal). See each file's top HTML comment for exactly which source
  screenshot(s) it covers.
- Charts (Sales Breakdown, Sales Qty Breakdown, Appointments line chart,
  Booking Quantity pie) are built as plain inline SVG polylines / CSS
  conic-gradient circles rather than a charting library, per the "simple
  HTML, don't over-invest in styling" brief - the shapes approximate what's
  in the source screenshots but aren't pixel-exact.
- Sample data is NOT end-to-end consistent across every section (e.g. the
  Home dashboard's numbers, the Appointments calendar's sample bookings, and
  the various report pages each reflect their own screenshot's snapshot in
  time) because the source screenshots are captures from different moments,
  not one continuous session.
