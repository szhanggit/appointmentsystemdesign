/* Groway investor demo — single data source. All pages read from DEMO. English only.
   Matches the usercasestudy design on GitHub master as of 2026-10-02
   (Batch 1: chain page + ?src= attribution; Batch 2: assignment-level status,
   one timetable per person; multi-service public booking; two consent checkboxes;
   stores.policies_text; ratings inert in V1 — no ratings rendered anywhere).
   Asset paths are site-root-relative ("assets/..."); pages under client/ prepend "../". */
const DEMO = {
  today: "Friday, October 2, 2026",
  chain: {
    id: "chain-selah",
    name: "Selah Head Spa",
    tagline: "A calm-luxury head spa ritual, now in two neighbourhoods.",
    hero: "assets/img/hero-spa.jpg",
    story: "Selah began in 2019 as a single head-spa studio in Richmond Hill, built around one belief: that an hour of unhurried scalp ritual can reset a whole week. Guests started driving in from across the GTA; in 2024 we opened our second studio in Yorkville. Same therapists, same ritual, two neighbourhoods."
  },
  stores: [
    { id: "store-bayview", name: "Selah Head Spa — Bayview",
      short: "Bayview",
      address: "8120 Bayview Ave, Richmond Hill, ON",
      phone: "(905) 555-0142",
      hours: "Mon–Sat 10:00–20:00, Sun 11:00–18:00",
      about: "Our original studio. Six treatment beds, a tea lounge, and the city's most-booked head spa ritual — ten minutes from Highway 404.",
      photos: ["assets/img/headspa-1.webp", "assets/img/hero-spa.jpg", "assets/img/massage-1.png"] },
    { id: "store-yorkville", name: "Selah Head Spa — Yorkville",
      short: "Yorkville",
      address: "128 Cumberland St, Toronto, ON",
      phone: "(416) 555-0198",
      hours: "Mon–Sat 10:00–21:00, Sun closed",
      about: "Our downtown studio in the heart of Yorkville. Evening appointments until 9 PM for the after-work reset.",
      photos: ["assets/img/headspa-2.webp", "assets/img/facial-1.png", "assets/img/hero-spa.jpg"] }
  ],
  staff: [
    { id: "anna", name: "Anna Chen", title: "Senior Scalp Therapist",
      avatar: "assets/img/avatar-47.jpg",
      languages: ["English", "Mandarin"],
      bio: "Ten years in scalp therapy and traditional Chinese head massage. Anna leads our scalp-analysis consultations and trains every new therapist on the Royal ritual.",
      years: 10, guestsServed: 3240,
      portfolio: ["assets/img/headspa-1.webp", "assets/img/headspa-2.webp"],
      active: { "store-bayview": true, "store-yorkville": true } },
    { id: "mei", name: "Mei Wang", title: "Head Spa Specialist",
      avatar: "assets/img/avatar-17.jpg",
      languages: ["Mandarin"],
      bio: "Mei specializes in aromatherapy scalp treatments and the Gua Sha add-on guests ask for by name. Five years with Selah.",
      years: 5, guestsServed: 1870,
      portfolio: ["assets/img/massage-1.png"],
      active: { "store-bayview": true, "store-yorkville": false } },
    { id: "jordan", name: "Jordan Lee", title: "Massage Therapist",
      avatar: "assets/img/avatar-26.jpg",
      languages: ["English"],
      bio: "Registered massage therapist focused on neck, shoulder and upper-back relief — the perfect close to any head spa session. Currently based at our Yorkville studio.",
      years: 7, guestsServed: 2115,
      portfolio: ["assets/img/massage-1.png"],
      active: { "store-bayview": false, "store-yorkville": true } },
    { id: "sofia", name: "Sofia Zhang", title: "Facial Specialist",
      avatar: "assets/img/avatar-33.jpg",
      languages: ["English", "Mandarin"],
      bio: "Sofia pairs our signature facials with lymphatic drainage techniques learned in Seoul. Ask her about the post-facial glow — it lasts for days.",
      years: 6, guestsServed: 1980,
      portfolio: ["assets/img/facial-1.png", "assets/img/nails-1.webp"],
      active: { "store-bayview": true, "store-yorkville": true } }
  ],
  /* sequence_order drives BOTH menu display order and combo execution order (design decision).
     staff[] = staff qualified to perform this service. */
  services: [
    { id: "svc-royal",  name: "Deluxe Royal Head Spa",       cat: "Head Spa", mins: 90, price: 129, seq: 1, staff: ["anna", "mei"] },
    { id: "svc-aroma",  name: "Aromatherapy Scalp Treatment", cat: "Head Spa", mins: 60, price: 89,  seq: 2, staff: ["anna"] },
    { id: "svc-facial", name: "Glow Facial",                  cat: "Facial",   mins: 45, price: 75,  seq: 3, staff: ["sofia", "mei"] },
    { id: "svc-deep",   name: "Deep Cleanse Facial",          cat: "Facial",   mins: 60, price: 95,  seq: 4, staff: ["sofia"] },
    { id: "svc-neck",   name: "Shoulder & Neck Massage",      cat: "Massage",  mins: 30, price: 55,  seq: 5, staff: ["jordan"] },
    { id: "svc-body",   name: "Aromatherapy Body Massage",    cat: "Massage",  mins: 60, price: 110, seq: 6, staff: ["jordan", "anna"] }
  ],
  policies: {
    en: "Cancellation is free up to 4 hours before your appointment. Late cancellations and no-shows may be charged 50% of the service price. Please arrive 10 minutes early — late arrivals may shorten your session. Children under 12 must be accompanied by an adult.",
    zh: "预约开始前4小时可免费取消。迟到取消或未到店可能收取服务价格50%的费用。请提前10分钟到店，迟到可能缩短您的服务时长。12岁以下儿童须由成人陪同。"
  },
  quota: { plan: "Free", used: 73, limit: 100 },
  srcLabels: { instagram: "Instagram", xiaohongshu: "Xiaohongshu", wechat: "WeChat", google: "Google" }
};
