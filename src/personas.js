// Sample clients for the demo. The same six clients appear for every profession, each with
// a real-world payment habit; only the work they buy changes with the profession.
//   Kiran   pays a monthly retainer like clockwork
//   Rachel  buys almost every month: the retainer suggestion
//   Marcus  always pays late: high risk, one invoice overdue
//   William a brand team on Net 30 that pays a couple of days late
//   Sofia   reliable, an invoice due soon
//   Daniel  a one-off private client
//
// A client has either a `plan` (repeat work every N days, with a cycle of how late each
// invoice was paid) or a `list` of single invoices: [days ago issued, days late, work].
// A `late` of null means the invoice is still open. A plan invoice whose payment date
// would be in the future is also still open, like in real life.

const C = (name, quantity, unitPrice) => [name, quantity, unitPrice];

export const ROSTER = [
  { key: 'kiran', name: 'Kiran Deshmukh', role: 'Principal Engineer', company: 'Overcast Labs', email: 'kiran@overcastlabs.io', net: 15 },
  { key: 'rachel', name: 'Rachel Adams', role: 'Operations Director', company: 'Summit Peak Consulting', email: 'rachel@summitpeakconsulting.com', net: 15 },
  { key: 'marcus', name: 'Marcus Vance', role: 'Founder & CEO', company: 'Apex Growth Lab', email: 'marcus@apexgrowthlab.io', net: 15 },
  { key: 'william', name: 'William Evans', role: 'Head of Brand', company: 'Voltline Energy', email: 'william@voltlineenergy.com', net: 30 },
  { key: 'sofia', name: 'Sofia Martinez', role: 'Marketing Manager', company: 'Lumen Health', email: 'sofia@lumenhealth.co', net: 15 },
  { key: 'daniel', name: 'Daniel Brooks', role: '', company: '', email: 'daniel.brooks@fastmail.com', net: 7 },
];

// What each client buys, per profession.
//   retainer: Kiran's monthly line   frequent: Rachel's rotating orders
//   marcus: 4 jobs (last one open)   william: 4 jobs (last open)   sofia: 3 (last open)   daniel: 1
const WORK = {
  web_developer: {
    retainer: C('Website maintenance and support (monthly)', 1, 650),
    frequent: [[C('Landing page build', 1, 480)], [C('Bug fixes and updates (per hour)', 5, 95)], [C('CMS template changes', 1, 360), C('Bug fixes and updates (per hour)', 2, 95)], [C('Booking form integration', 1, 540)]],
    marcus: [[C('Marketing site rebuild, phase 1', 1, 2400)], [C('Stripe checkout integration', 1, 950)], [C('Marketing site rebuild, phase 2', 1, 1800)], [C('Analytics dashboard API', 1, 1150), C('Bug fixes and updates (per hour)', 4, 95)]],
    william: [[C('Product launch microsite', 1, 1600)], [C('Store locator API integration', 1, 950)], [C('Performance and accessibility fixes', 1, 720)], [C('Promo page build', 1, 680)]],
    sofia: [[C('Blog theme customisation', 1, 420)], [C('Newsletter signup integration', 1, 380)], [C('Patient portal login page', 1, 560)]],
    daniel: [[C('Personal portfolio site', 1, 900)]],
  },
  content_writer: {
    retainer: C('Monthly content retainer (4 blog posts)', 1, 1200),
    frequent: [[C('Blog post (1,500 words)', 2, 350)], [C('Case study', 1, 450), C('LinkedIn posts', 4, 60)], [C('Email newsletter', 2, 180), C('Blog post (1,500 words)', 1, 350)], [C('Website copy (per page)', 2, 250)]],
    marcus: [[C('Website copy (per page)', 6, 250)], [C('Pitch deck copy', 1, 650)], [C('Sales email sequence (5 emails)', 1, 900)], [C('Website copy (per page)', 4, 250), C('Product descriptions', 12, 25)]],
    william: [[C('Product launch press release', 1, 600)], [C('Can and packaging copy', 1, 850)], [C('Brand voice guide', 1, 1200)], [C('Campaign taglines and scripts', 1, 700)]],
    sofia: [[C('Blog post (1,500 words)', 1, 350)], [C('Patient guide rewrite', 1, 520)], [C('Email newsletter', 2, 180)]],
    daniel: [[C('Wedding speech editing', 1, 180)]],
  },
  digital_marketer: {
    retainer: C('Social media management (monthly)', 1, 1200),
    frequent: [[C('Google Ads campaign setup', 1, 750)], [C('Performance report', 1, 300), C('Ad creative refresh', 1, 280)], [C('SEO content plan', 1, 520)], [C('LinkedIn campaign setup', 1, 650)]],
    marcus: [[C('SEO audit', 1, 950), C('Keyword research', 1, 400)], [C('Paid social launch', 1, 1400)], [C('Conversion rate review', 1, 850)], [C('Q4 campaign management', 1, 1100), C('Performance report', 1, 300)]],
    william: [[C('Influencer campaign planning', 1, 1800)], [C('Paid social, product launch', 1, 1500)], [C('SEO audit', 1, 950)], [C('Holiday campaign setup', 1, 900)]],
    sofia: [[C('Local SEO setup', 1, 600)], [C('Google Business profile optimisation', 1, 350)], [C('Email campaign setup', 1, 450)]],
    daniel: [[C('Social media audit', 1, 250)]],
  },
  video_editor: {
    retainer: C('Monthly editing package (4 videos)', 1, 1100),
    frequent: [[C('YouTube video edit (10–15 min)', 2, 320)], [C('Short-form clips pack (10)', 1, 400)], [C('YouTube video edit (10–15 min)', 1, 320), C('Thumbnail design', 2, 45)], [C('Webinar recording edit', 1, 380)]],
    marcus: [[C('Promo video (60 sec)', 1, 850), C('Colour grading and sound mix', 1, 180)], [C('Founder interview edit', 1, 640)], [C('Product demo video', 1, 980)], [C('Promo video (60 sec)', 1, 850), C('Short-form clips pack (10)', 1, 400)]],
    william: [[C('Launch ad, 30 and 15 sec cuts', 1, 1400)], [C('Event highlight reel', 1, 900)], [C('Social cutdowns (12)', 1, 600)], [C('Athlete interview series edit', 1, 760)]],
    sofia: [[C('Patient testimonial video', 1, 480)], [C('Clinic tour video', 1, 620)], [C('Short-form clips pack (10)', 1, 400)]],
    daniel: [[C('Wedding highlights film', 1, 750)]],
  },
  consultant: {
    retainer: C('Monthly advisory retainer', 1, 2500),
    frequent: [[C('Strategy session (half day)', 1, 1100)], [C('Advisory (per hour)', 6, 180)], [C('Pricing review', 1, 1450)], [C('Strategy session (half day)', 1, 1100), C('Advisory (per hour)', 2, 180)]],
    marcus: [[C('Go-to-market strategy', 1, 3200)], [C('Market research report', 1, 2400)], [C('Investor readiness review', 1, 1800)], [C('Competitor analysis', 1, 1500), C('Advisory (per hour)', 4, 180)]],
    william: [[C('Retail channel strategy', 1, 2800)], [C('Customer survey and analysis', 1, 1900)], [C('Pricing study', 1, 1600)], [C('Quarterly strategy workshop', 1, 1400)]],
    sofia: [[C('Patient journey mapping', 1, 1200)], [C('Advisory (per hour)', 5, 180)], [C('Referral programme design', 1, 950)]],
    daniel: [[C('Business plan review', 1, 600)]],
  },
  photographer: {
    retainer: C('Monthly content shoot (team and product)', 1, 900),
    frequent: [[C('Product shoot (half day)', 1, 900)], [C('Edited photos (per image)', 20, 25)], [C('Event photography (3 hours)', 1, 650)], [C('Headshot session', 2, 350)]],
    marcus: [[C('Brand photoshoot (full day)', 1, 1800)], [C('Office and team photos', 1, 750)], [C('Product shoot (half day)', 1, 900), C('Usage licence (1 year)', 1, 400)], [C('Campaign shoot', 1, 1300), C('Edited photos (per image)', 12, 25)]],
    william: [[C('Product packshots (40 images)', 1, 1600)], [C('Athlete lifestyle shoot', 1, 2200)], [C('Event photography (3 hours)', 1, 650)], [C('Retail display photos', 1, 700)]],
    sofia: [[C('Clinic interior photos', 1, 600)], [C('Headshot session', 3, 350)], [C('Edited photos (per image)', 15, 25)]],
    daniel: [[C('Family portrait session', 1, 450)]],
  },
  virtual_assistant: {
    retainer: C('Inbox and calendar management (monthly)', 1, 600),
    frequent: [[C('Admin support (per hour)', 12, 35)], [C('Data entry (per hour)', 10, 30)], [C('Travel booking', 2, 75), C('Admin support (per hour)', 6, 35)], [C('CRM clean-up (per hour)', 9, 35)]],
    marcus: [[C('Admin support (per hour)', 30, 35)], [C('Investor update preparation', 1, 280)], [C('Admin support (per hour)', 24, 35)], [C('Event logistics', 1, 450), C('Admin support (per hour)', 10, 35)]],
    william: [[C('Trade show logistics', 1, 650)], [C('Data entry (per hour)', 25, 30)], [C('Vendor research', 1, 380)], [C('Sample shipping coordination', 1, 320)]],
    sofia: [[C('Appointment reminders setup', 1, 260)], [C('Admin support (per hour)', 8, 35)], [C('Data entry (per hour)', 12, 30)]],
    daniel: [[C('Move planning and bookings', 1, 300)]],
  },
  other: {
    retainer: C('Monthly retainer', 1, 800),
    frequent: [[C('Professional services (per hour)', 6, 75)], [C('Project fee', 1, 520)], [C('Consultation', 2, 150), C('Professional services (per hour)', 3, 75)], [C('Materials and expenses', 1, 100), C('Professional services (per hour)', 5, 75)]],
    marcus: [[C('Project fee', 1, 1600)], [C('Professional services (per hour)', 12, 75)], [C('Project fee', 1, 1200)], [C('Project fee', 1, 1100), C('Materials and expenses', 1, 140)]],
    william: [[C('Project fee', 1, 1400)], [C('Professional services (per hour)', 14, 75)], [C('Consultation', 3, 150)], [C('Project fee', 1, 700)]],
    sofia: [[C('Consultation', 2, 150)], [C('Professional services (per hour)', 6, 75)], [C('Project fee', 1, 480)]],
    daniel: [[C('Consultation', 1, 150), C('Professional services (per hour)', 2, 75)]],
  },
};

/** The demo clients and their habits for one profession (null for the hand-made design studio). */
export function personaFor(profession) {
  const w = WORK[profession];
  if (!w) return null;
  const R = Object.fromEntries(ROSTER.map((c) => [c.key, c]));
  return [
    { ...R.kiran, plan: { every: 30, from: 170, delays: [0, 0, 1, 0, 0, 0], work: [[w.retainer]] }, retainer: { item: w.retainer, due: 15 } },
    { ...R.rachel, plan: { every: 34, from: 170, delays: [0, 2, 1, 0, 3, 1], work: w.frequent } },
    { ...R.marcus, list: [[160, 13, w.marcus[0]], [118, 16, w.marcus[1]], [75, 19, w.marcus[2]], [27, null, w.marcus[3]]] },
    { ...R.william, list: [[165, 2, w.william[0]], [112, 3, w.william[1]], [64, 2, w.william[2]], [33, null, w.william[3]]] },
    { ...R.sofia, list: [[130, 0, w.sofia[0]], [85, 1, w.sofia[1]], [14, null, w.sofia[2]]] },
    { ...R.daniel, list: [[45, 0, w.daniel[0]]] },
  ];
}

/** Small, repeatable wobble so plan dates don't look machine-made. */
const WOBBLE = [0, 3, -2, 4, -3, 1, -1, 2];

/**
 * Turn a persona into dated invoice rows. Returns [{ client, ago, late, work }]
 * where late === null means still open.
 */
export function personaInvoices(clients) {
  const rows = [];
  for (const c of clients) {
    if (c.plan) {
      const { every, from, delays, work } = c.plan;
      let ago = from;
      for (let i = 0; ago >= 2; i++) {
        const late = delays[i % delays.length];
        const paidAgo = ago - c.net - late; // days ago it was / will be paid
        rows.push({ client: c, ago, late: paidAgo >= 1 ? late : null, work: work[i % work.length] });
        ago -= every + WOBBLE[i % WOBBLE.length];
      }
    }
    for (const [ago, late, work] of c.list || []) rows.push({ client: c, ago, late, work });
  }
  return rows.sort((a, b) => b.ago - a.ago);
}
