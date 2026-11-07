// Business types. PayPilot doesn't care what work you do; it cares how you get paid.
// A type only tunes the defaults: payment terms, reminder style, the note on invoices,
// the line items offered as shortcuts, the words used for clients and retainers, and
// which sample business the demo loads.

export const BUSINESS_TYPES = {
  freelancer: {
    label: 'Freelancer',
    blurb: 'Design, writing, development, photography',
    client: 'client',
    retainer: 'monthly retainer',
    terms: 15,
    style: 'warm',
    note: 'Thank you for the work together. Payment is due by the date above.',
    items: [
      ['Design work (per hour)', 85],
      ['Revisions round', 120],
      ['Logo and brand kit', 900],
      ['Social media pack', 390],
    ],
    persona: 'studio',
  },
  agency: {
    label: 'Agency',
    blurb: 'Small teams billing projects and retainers',
    client: 'client',
    retainer: 'monthly retainer',
    terms: 30,
    style: 'neutral',
    note: 'Thank you for your business. Payment terms are as agreed in the statement of work.',
    items: [
      ['Strategy and planning (per hour)', 140],
      ['Campaign production', 2400],
      ['Monthly reporting', 350],
      ['Ad management', 800],
    ],
    persona: 'studio',
  },
  clinic: {
    label: 'Clinic',
    blurb: 'Physio, therapy, dental, wellness',
    client: 'patient or partner',
    retainer: 'care plan',
    terms: 7,
    style: 'warm',
    note: 'Thank you for choosing us. Please contact the front desk with any billing questions.',
    items: [
      ['Initial assessment', 120],
      ['Follow-up session', 85],
      ['6-session treatment pack', 480],
      ['Corporate wellness day', 1400],
    ],
    persona: 'clinic',
  },
  tutor: {
    label: 'Tutoring',
    blurb: 'Tutors, coaches, music and language teachers',
    client: 'family',
    retainer: 'monthly lesson plan',
    terms: 7,
    style: 'warm',
    note: 'Thank you! Lessons for the next block are reserved once this is paid.',
    items: [
      ['One-to-one lesson (60 min)', 55],
      ['Lesson pack, 8 sessions', 400],
      ['Exam prep workshop', 180],
      ['Progress report', 40],
    ],
    persona: 'tutor',
  },
  trades: {
    label: 'Trades and repair',
    blurb: 'Plumbing, HVAC, electrical, handyman',
    client: 'customer',
    retainer: 'maintenance plan',
    terms: 0,
    style: 'brief',
    note: 'Thank you for your business. All work is guaranteed for 90 days.',
    items: [
      ['Call-out fee', 95],
      ['Labour (per hour)', 78],
      ['Parts and materials', 150],
      ['Annual system service', 220],
    ],
    persona: 'trades',
  },
  consulting: {
    label: 'Consulting',
    blurb: 'Advisors, accountants, coaches, analysts',
    client: 'client',
    retainer: 'advisory retainer',
    terms: 30,
    style: 'neutral',
    note: 'Thank you for the engagement. Payment is due within the agreed terms.',
    items: [
      ['Advisory (per hour)', 180],
      ['Strategy workshop', 2200],
      ['Board pack review', 650],
      ['Monthly advisory', 3000],
    ],
    persona: 'consulting',
  },
};

export const typeOf = (key) => BUSINESS_TYPES[key] || BUSINESS_TYPES.freelancer;

/** Safe list for the browser. */
export function businessTypeList() {
  return Object.entries(BUSINESS_TYPES).map(([key, t]) => ({
    key,
    label: t.label,
    blurb: t.blurb,
    terms: t.terms,
    style: t.style,
    note: t.note,
    items: t.items.map(([name, price]) => ({ name, price })),
    retainer: t.retainer,
    client: t.client,
  }));
}
