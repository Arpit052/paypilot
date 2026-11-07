// Sample businesses for the demo, one per kind of work. Each client has a habit:
// some pay like clockwork, some always a little late, one is a chronic late payer,
// and one buys so often that a retainer would suit both sides.
//
// A client has either a `plan` (repeat work every N days, with a cycle of how late each
// invoice was paid) or a `list` of single invoices: [days ago issued, days late, work].
// A `late` of null means the invoice is still open. A plan invoice whose payment date
// would be in the future is also still open, like in real life.

const C = (name, quantity, unitPrice) => [name, quantity, unitPrice];

export const PERSONAS = {
  clinic: [
    {
      key: 'harbor', name: 'Elena Brooks', company: 'Harbor Logistics', email: 'hr@harborlogistics.com', net: 15,
      plan: { every: 30, from: 170, delays: [0, 1, 0, 0, 2, 0], work: [[C('Corporate wellness programme (monthly)', 1, 1200)]] },
      retainer: { item: C('Corporate wellness programme (monthly)', 1, 1200), due: 15 },
    },
    {
      key: 'westfield', name: 'Sam Doyle', company: 'Westfield Rugby Club', email: 'treasurer@westfieldrfc.org', net: 7,
      plan: {
        every: 37, from: 172, delays: [1, 3, 0, 2, 4, 1, 2],
        work: [
          [C('Match-day taping and pitch-side physio', 1, 320)],
          [C('Squad screening, 12 players', 12, 35)],
          [C('Injury rehab sessions', 5, 85), C('Taping supplies', 1, 45)],
          [C('Match-day taping and pitch-side physio', 1, 320), C('Travel to away fixture', 1, 60)],
        ],
      },
    },
    {
      key: 'avery', name: 'Tom Avery', company: '', email: 'tom.avery@fastmail.com', net: 7,
      list: [[150, 2, [C('6-session treatment pack', 1, 480)]], [92, 9, [C('Follow-up session', 3, 85)]], [30, null, [C('6-session treatment pack', 1, 480), C('Home exercise kit', 1, 45)]]],
    },
    {
      key: 'lakeside', name: 'Karen Ruiz', company: 'Lakeside Senior Living', email: 'accounts@lakesideseniorliving.com', net: 30,
      list: [[175, 8, [C('Group mobility classes', 8, 90)]], [140, 12, [C('Group mobility classes', 8, 90)]], [105, 9, [C('Falls-prevention screening', 20, 30)]], [70, 14, [C('Group mobility classes', 8, 90)]], [40, null, [C('Group mobility classes', 8, 90), C('Staff manual-handling workshop', 1, 380)]]],
    },
    {
      key: 'mia', name: 'Mia Chen', company: '', email: 'mia.chen@outlook.com', net: 7,
      list: [[60, 0, [C('Initial assessment', 1, 120), C('Follow-up session', 1, 85)]], [33, 0, [C('Follow-up session', 2, 85)]]],
    },
  ],

  tutor: [
    {
      key: 'patel', name: 'Raj Patel', company: '', email: 'raj.patel@yahoo.com', net: 7,
      plan: { every: 30, from: 168, delays: [0, 0, 1, 0, 0, 1], work: [[C('Monthly lesson plan, 8 sessions', 1, 400)]] },
      retainer: { item: C('Monthly lesson plan, 8 sessions', 1, 400), due: 7 },
    },
    {
      key: 'morales', name: 'Ana Morales', company: '', email: 'ana.morales@gmail.com', net: 7,
      plan: {
        every: 34, from: 170, delays: [0, 2, 1, 0, 3, 1],
        work: [
          [C('Maths tutoring, 4 sessions', 4, 55)],
          [C('Maths tutoring, 4 sessions', 4, 55), C('Practice test pack', 1, 25)],
          [C('Maths and physics, 5 sessions', 5, 55)],
        ],
      },
    },
    {
      key: 'greenfield', name: 'Laura Kim', company: 'Greenfield Academy', email: 'finance@greenfieldacademy.org', net: 30,
      list: [[160, 6, [C('SAT prep workshop', 3, 180)]], [95, 11, [C('Exam prep workshop', 4, 180)]], [45, null, [C('Revision bootcamp (2 days)', 2, 450)]]],
    },
    {
      key: 'owen', name: 'Owen Brooks', company: '', email: 'owen.brooks@icloud.com', net: 7,
      list: [[120, 15, [C('Lesson pack, 8 sessions', 1, 400)]], [65, 21, [C('Lesson pack, 8 sessions', 1, 400)]], [26, null, [C('Lesson pack, 8 sessions', 1, 400), C('Progress report', 1, 40)]]],
    },
    {
      key: 'sofia', name: 'Sofia Lindqvist', company: '', email: 'sofia.lindqvist@proton.me', net: 7,
      list: [[80, 0, [C('IELTS speaking prep', 6, 60)]], [18, 0, [C('Mock exam with written feedback', 1, 90)]]],
    },
  ],

  trades: [
    {
      key: 'dental', name: 'Dr. Omar Siddiqui', company: 'Maple Street Dental', email: 'office@maplestreetdental.com', net: 15,
      plan: { every: 30, from: 172, delays: [0, 0, 2, 0, 1, 0], work: [[C('HVAC maintenance plan (monthly)', 1, 260)]] },
      retainer: { item: C('HVAC maintenance plan (monthly)', 1, 260), due: 15 },
    },
    {
      key: 'cedar', name: 'Nina Alvarez', company: 'Cedar Point Property Management', email: 'maintenance@cedarpointpm.com', net: 15,
      plan: {
        every: 36, from: 176, delays: [3, 5, 2, 6, 4, 8, 3, 5, 2, 4, 6],
        work: [
          [C('Leaking tap repair, unit 4B', 1, 145)],
          [C('Call-out fee', 1, 95), C('Labour (per hour)', 2, 78), C('Parts and materials', 1, 64)],
          [C('Water heater thermostat replacement', 1, 310)],
          [C('Gutter clearing, 3 buildings', 3, 120)],
          [C('Emergency call-out (weekend)', 1, 180), C('Labour (per hour)', 3, 78)],
        ],
      },
    },
    {
      key: 'novak', name: 'Greg Novak', company: '', email: 'greg.novak@gmail.com', net: 0,
      list: [[130, 12, [C('AC tune-up', 1, 180)]], [24, null, [C('Water heater replacement, 50 gal', 1, 1450), C('Labour (per hour)', 4, 78), C('Old unit haul-away', 1, 60)]]],
    },
    {
      key: 'rossi', name: 'Marco Rossi', company: 'Rossi Bakery', email: 'marco@rossibakery.com', net: 15,
      list: [[165, 6, [C('Oven vent cleaning', 1, 260)]], [110, 9, [C('Walk-in cooler repair', 1, 540)]], [52, 7, [C('Oven vent cleaning', 1, 260), C('Grease trap service', 1, 140)]], [12, null, [C('Walk-in cooler door seal', 1, 210)]]],
    },
    {
      key: 'linda', name: 'Linda Park', company: '', email: 'linda.park@hotmail.com', net: 0,
      list: [[75, 1, [C('Ceiling fan installation', 2, 140)]], [30, 0, [C('Smoke detector replacement', 5, 38)]]],
    },
  ],

  consulting: [
    {
      key: 'ledgerly', name: 'Jordan Price', company: 'Ledgerly Inc.', email: 'ap@ledgerly.io', net: 30,
      plan: { every: 30, from: 175, delays: [0, 2, 0, 1, 0, 0], work: [[C('Monthly advisory', 1, 3000)]] },
      retainer: { item: C('Monthly advisory', 1, 3000), due: 30 },
    },
    {
      key: 'summit', name: 'Hannah Lee', company: 'Summit Outdoor Co.', email: 'hannah@summitoutdoor.co', net: 15,
      plan: {
        every: 34, from: 170, delays: [1, 0, 3, 2, 0, 4],
        work: [
          [C('Strategy session (half day)', 1, 1100)],
          [C('Advisory (per hour)', 6, 180)],
          [C('Pricing review', 1, 1450)],
          [C('Strategy session (half day)', 1, 1100), C('Advisory (per hour)', 2, 180)],
        ],
      },
    },
    {
      key: 'crane', name: 'Victor Crane', company: 'Crane & Co. Logistics', email: 'payables@cranelogistics.com', net: 45,
      list: [[175, 18, [C('Market entry study', 1, 4800)]], [110, 25, [C('Operations review', 1, 3600)]], [70, null, [C('Warehouse network analysis', 1, 4200)]]],
    },
    {
      key: 'bluefin', name: 'Priyanka Shah', company: 'Bluefin Analytics', email: 'finance@bluefinanalytics.com', net: 30,
      list: [[150, 2, [C('Board pack review', 1, 650)]], [90, 3, [C('Fundraising model', 1, 2800)]], [20, null, [C('Investor Q&A preparation', 1, 1200)]]],
    },
    {
      key: 'nora', name: 'Nora Haddad', company: 'Haddad Coaching', email: 'nora@haddadcoaching.com', net: 15,
      list: [[100, 0, [C('Leadership coaching', 4, 220)]], [40, 1, [C('Leadership coaching', 4, 220)]]],
    },
  ],
};

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
