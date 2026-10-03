/* Groway investor demo — ADMIN (platform ops) data.
   Owned by the admin-pages build. Does NOT touch Agent 1's assets/js/demo-data.js.
   All figures are illustrative demo content. Quota model (V1, per design):
   Free plan = 100 bookings/month per CHAIN; warnings at 75/90/100%;
   hard block on overage (no top-up pack in V1); unused quota does not roll over. */
(function () {
  "use strict";

  var PLATFORM = {
    quotaModel: { plan: "Free", limit: 100, warnAt: [75, 90, 100], overage: "hard-block" },

    chains: [
      {
        id: "chain-selah", name: "Selah Head Spa", owner: "Sarah Zhang",
        email: "sarah@selahspa.ca", plan: "Free", quotaUsed: 73, quotaLimit: 100,
        status: "Active", since: "Sep 18, 2026",
        stores: [
          { id: "store-bayview", name: "Selah Head Spa \u2014 Bayview",
            address: "8120 Bayview Ave, Richmond Hill, ON", phone: "(905) 555-0142",
            status: "Active", staff: 6, bookings: 47 },
          { id: "store-yorkville", name: "Selah Head Spa \u2014 Yorkville",
            address: "128 Cumberland St, Toronto, ON", phone: "(416) 555-0198",
            status: "Active", staff: 4, bookings: 26 }
        ]
      },
      {
        id: "chain-glow", name: "Glow Studio", owner: "Priya Nair",
        email: "priya@glowstudio.ca", plan: "Free", quotaUsed: 96, quotaLimit: 100,
        status: "Active", since: "Aug 2, 2026",
        stores: [
          { id: "store-glow-main", name: "Glow Studio \u2014 Main",
            address: "8360 Kennedy Rd, Markham, ON", phone: "(905) 555-0117",
            status: "Active", staff: 3, bookings: 96 }
        ]
      },
      {
        id: "chain-luxe", name: "Luxe Nails Bar", owner: "Daniel Kim",
        email: "daniel@luxenails.ca", plan: "Free", quotaUsed: 100, quotaLimit: 100,
        status: "Quota exhausted", since: "Jul 11, 2026",
        stores: [
          { id: "store-luxe-dt", name: "Luxe Nails Bar \u2014 Downtown",
            address: "220 King St W, Toronto, ON", phone: "(416) 555-0160",
            status: "Active", staff: 5, bookings: 100 }
        ]
      }
    ],

    accounts: [
      { name: "Sarah Zhang", email: "sarah@selahspa.ca", role: "Chain owner", scope: "Selah Head Spa", status: "Active", lastLogin: "Oct 2, 2026 \u00b7 9:41 AM" },
      { name: "Lisa Wang", email: "lisa.w@selahspa.ca", role: "Store admin", scope: "Selah Head Spa \u2014 Bayview", status: "Active", lastLogin: "Oct 2, 2026 \u00b7 8:15 AM" },
      { name: "Priya Nair", email: "priya@glowstudio.ca", role: "Chain owner", scope: "Glow Studio", status: "Active", lastLogin: "Oct 1, 2026 \u00b7 6:02 PM" },
      { name: "Daniel Kim", email: "daniel@luxenails.ca", role: "Chain owner", scope: "Luxe Nails Bar", status: "Active", lastLogin: "Oct 2, 2026 \u00b7 10:20 AM" },
      { name: "Grace Liu", email: "grace@groway.ca", role: "Groway admin", scope: "Platform", status: "Active", lastLogin: "Oct 2, 2026 \u00b7 9:00 AM" },
      { name: "Tom Baker", email: "tom@groway.ca", role: "Groway admin", scope: "Platform", status: "Active", lastLogin: "Sep 30, 2026 \u00b7 4:44 PM" },
      { name: "Kevin Zhou", email: "kevin.z@luxenails.ca", role: "Store admin", scope: "Luxe Nails Bar \u2014 Downtown", status: "Suspended", lastLogin: "Sep 12, 2026 \u00b7 2:10 PM" }
    ],

    appointments: [
      { ref: "K7Q2-M9XA", chain: "Selah Head Spa", store: "Bayview", customer: "Kevin Liu",
        service: "Deluxe Royal Head Spa", staff: "Amy", when: "Oct 2 \u00b7 6:00 PM",
        channel: "public_web", src: "Instagram", status: "Confirmed" },
      { ref: "Q3T8-R2ZB", chain: "Selah Head Spa", store: "Bayview", customer: "Brianna Zabel",
        service: "Foot Reflexology Massage", staff: "Amy", when: "Oct 2 \u00b7 10:15 AM",
        channel: "public_web", src: "\u2014", status: "Completed" },
      { ref: "M4W6-N7PC", chain: "Selah Head Spa", store: "Yorkville", customer: "Walk-in",
        service: "Scalp Care", staff: "Eva", when: "Oct 2 \u00b7 1:00 PM",
        channel: "staff_manual", src: "\u2014", status: "Serving" },
      { ref: "H9D2-K5QT", chain: "Glow Studio", store: "Main", customer: "Sophia Lin",
        service: "Japanese Gel Manicure", staff: "Nina", when: "Oct 2 \u00b7 2:00 PM",
        channel: "public_web", src: "Xiaohongshu", status: "Confirmed" },
      { ref: "P5F7-V3WM", chain: "Glow Studio", store: "Main", customer: "Maya Chen",
        service: "Structured Manicure", staff: "Lucy", when: "Oct 1 \u00b7 4:30 PM",
        channel: "public_web", src: "\u2014", status: "Completed" },
      { ref: "R8S1-T6YN", chain: "Luxe Nails Bar", store: "Downtown", customer: "Olivia Zhang",
        service: "Volume Lash Set", staff: "Connie", when: "Oct 2 \u00b7 10:00 AM",
        channel: "public_web", src: "\u2014", status: "No-Show" },
      { ref: "D2G9-X4KL", chain: "Luxe Nails Bar", store: "Downtown", customer: "Daniel Wu",
        service: "Classic Lash Set", staff: "Connie", when: "Oct 1 \u00b7 3:30 PM",
        channel: "staff_manual", src: "\u2014", status: "Cancelled" },
      { ref: "W6H4-J8DR", chain: "Selah Head Spa", store: "Yorkville", customer: "Natalie Kwong",
        service: "Aromatherapy Scalp Treatment", staff: "Mei", when: "Oct 3 \u00b7 11:00 AM",
        channel: "public_web", src: "WeChat", status: "Confirmed" }
    ],

    notifications: [
      { id: "N-90412", ch: "SMS", to: "(647) 555-0149", chain: "Selah Head Spa",
        kind: "Booking confirmation", ref: "K7Q2-M9XA", status: "Delivered",
        sent: "Oct 2 \u00b7 2:14 PM", provider: "Twilio" },
      { id: "N-90411", ch: "Email", to: "kevin.liu@…", chain: "Selah Head Spa",
        kind: "Booking confirmation", ref: "K7Q2-M9XA", status: "Sent",
        sent: "Oct 2 \u00b7 2:14 PM", provider: "SES" },
      { id: "N-90398", ch: "SMS", to: "(416) 555-0132", chain: "Selah Head Spa",
        kind: "Reminder (24h)", ref: "Q3T8-R2ZB", status: "Delivered",
        sent: "Oct 1 \u00b7 10:15 AM", provider: "Twilio" },
      { id: "N-90377", ch: "SMS", to: "(416) 555-0119", chain: "Glow Studio",
        kind: "Reminder (24h)", ref: "H9D2-K5QT", status: "Delivered",
        sent: "Oct 1 \u00b7 2:00 PM", provider: "Twilio" },
      { id: "N-90360", ch: "Email", to: "sophia.lin@…", chain: "Glow Studio",
        kind: "Booking confirmation", ref: "H9D2-K5QT", status: "Sent",
        sent: "Oct 1 \u00b7 11:42 AM", provider: "SES" },
      { id: "N-90341", ch: "SMS", to: "(416) 555-0100", chain: "Luxe Nails Bar",
        kind: "Booking confirmation", ref: "R8S1-T6YN", status: "Failed",
        sent: "Oct 1 \u00b7 9:05 AM", provider: "Twilio", note: "Invalid number" },
      { id: "N-90322", ch: "Email", to: "daniel@luxenails.ca", chain: "Luxe Nails Bar",
        kind: "Quota warning (100%)", ref: "\u2014", status: "Sent",
        sent: "Sep 30 \u00b7 8:00 AM", provider: "SES" },
      { id: "N-90310", ch: "Email", to: "priya@glowstudio.ca", chain: "Glow Studio",
        kind: "Quota warning (90%)", ref: "\u2014", status: "Sent",
        sent: "Sep 29 \u00b7 8:00 AM", provider: "SES" }
    ],

    photoQueue: [
      { id: "P-301", img: "avatar-47.jpg", kind: "Staff avatar", who: "Mei Wang",
        store: "Selah Head Spa \u2014 Bayview", submitted: "Oct 2 \u00b7 11:20 AM", status: "Pending" },
      { id: "P-302", img: "headspa-2.webp", kind: "Portfolio photo", who: "Anna Chen",
        store: "Selah Head Spa \u2014 Yorkville", submitted: "Oct 2 \u00b7 10:02 AM", status: "Pending" },
      { id: "P-303", img: "nails-1.webp", kind: "Portfolio photo", who: "Nina",
        store: "Glow Studio \u2014 Main", submitted: "Oct 1 \u00b7 4:47 PM", status: "Pending" },
      { id: "P-304", img: "avatar-26.jpg", kind: "Staff avatar", who: "Luna",
        store: "Selah Head Spa \u2014 Bayview", submitted: "Oct 1 \u00b7 9:15 AM", status: "Pending" }
    ],

    activity: [
      { t: "Oct 2 \u00b7 2:14 PM", text: "Booking K7Q2-M9XA confirmed \u2014 confirmation SMS + email sent (Selah Head Spa \u2014 Bayview)." },
      { t: "Oct 2 \u00b7 11:20 AM", text: "Mei Wang submitted a new staff avatar for review (Selah Head Spa \u2014 Bayview)." },
      { t: "Oct 2 \u00b7 10:02 AM", text: "Anna Chen submitted a portfolio photo for review (Selah Head Spa \u2014 Yorkville)." },
      { t: "Oct 1 \u00b7 6:02 PM", text: "Priya Nair (Glow Studio) signed in \u2014 chain is at 96/100 bookings this month." },
      { t: "Sep 30 \u00b7 8:00 AM", text: "Quota-exhausted notice sent to Luxe Nails Bar \u2014 new bookings are hard-blocked until Nov 1." },
      { t: "Sep 29 \u00b7 8:00 AM", text: "90% quota warning sent to Glow Studio." },
      { t: "Sep 18 \u00b7 3:40 PM", text: "New chain self-registered: Selah Head Spa (2 stores) \u2014 no approval step in V1." }
    ],

    taxonomyAdoption: [
      ["head-spa", 2], ["facial", 2], ["nails", 2], ["hair", 1],
      ["massage", 1], ["lashes-brows", 1], ["waxing", 0], ["med-aesthetics", 1]
    ]
  };

  /* Quota helpers shared by admin pages. */
  function quotaPct(chain) {
    return Math.min(100, Math.round(chain.quotaUsed / chain.quotaLimit * 100));
  }
  function quotaBand(chain) {
    var p = quotaPct(chain);
    if (p >= 100) return { label: "Exhausted", cls: "danger", bar: "bg-danger" };
    if (p >= 90) return { label: "90% warning", cls: "warning", bar: "bg-warning" };
    if (p >= 75) return { label: "75% warning", cls: "warning", bar: "bg-warning" };
    return { label: "Healthy", cls: "success", bar: "bg-success" };
  }
  /* Renders the quota bar with 75/90/100% band markers. `el` is a jQuery object. */
  function renderQuotaBar(el, chain) {
    var p = quotaPct(chain), band = quotaBand(chain);
    var html = '<div class="quota-wrap position-relative mb-1">' +
      '<div class="progress" style="height:10px;">' +
      '<div class="progress-bar ' + band.bar + '" role="progressbar" style="width:' + p + '%"></div>' +
      "</div>" +
      '<span class="quota-tick" style="left:75%" title="75% warning"></span>' +
      '<span class="quota-tick" style="left:90%" title="90% warning"></span>' +
      "</div>" +
      '<div class="d-flex justify-content-between align-items-center">' +
      '<small class="text-muted">' + chain.quotaUsed + " / " + chain.quotaLimit + " bookings</small>" +
      '<span class="badge text-bg-' + band.cls + '">' + band.label + "</span>" +
      "</div>";
    el.html(html);
  }

  window.PLATFORM = PLATFORM;
  window.PLATFORM_QUOTA = { pct: quotaPct, band: quotaBand, renderBar: renderQuotaBar };
})();
