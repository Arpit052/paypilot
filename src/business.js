// What kind of work you do. PayPilot doesn't care what you sell; it cares how you get paid.
// A profession only tunes the defaults: payment terms, reminder style, the note on invoices,
// the line items offered as shortcuts, the words used for retainers, and the sample work
// the demo loads. "Other" lets people type their own.

const T = (label, blurb, o) => ({ label, blurb, client: 'client', ...o });

export const BUSINESS_TYPES = {
  web_developer: T('Web Developer', 'Website development, API integration', {
    retainer: 'maintenance retainer',
    terms: 15,
    style: 'neutral',
    note: 'Thank you for the project. Payment is due by the date above; code and access are handed over once paid.',
    items: [['Website development (fixed fee)', 2400], ['API integration', 950], ['Bug fixes and updates (per hour)', 95], ['Hosting and maintenance (monthly)', 250]],
  }),
  graphic_designer: T('Graphic Designer', 'Brand identity, UI/UX design', {
    retainer: 'design retainer',
    terms: 15,
    style: 'warm',
    note: 'Thank you for the work together. Final files are delivered once this invoice is paid.',
    items: [['Brand identity package', 1800], ['UI/UX design (per screen)', 180], ['Social media graphics pack', 390], ['Revisions round', 120]],
  }),
  content_writer: T('Content Writer', 'Blog writing, copywriting', {
    retainer: 'content retainer',
    terms: 15,
    style: 'warm',
    note: 'Thank you! Usage rights transfer to you once this invoice is paid.',
    items: [['Blog post (1,500 words)', 350], ['Website copy (per page)', 250], ['Email newsletter', 180], ['SEO content brief', 90]],
  }),
  digital_marketer: T('Digital Marketer', 'SEO, social media campaigns', {
    retainer: 'marketing retainer',
    terms: 15,
    style: 'neutral',
    note: 'Thank you for your business. Ad spend is billed separately by the ad platforms.',
    items: [['SEO audit', 950], ['Social media management (monthly)', 1200], ['Ad campaign setup', 750], ['Performance report', 300]],
  }),
  video_editor: T('Video Editor', 'YouTube videos, promotional content', {
    retainer: 'monthly editing package',
    terms: 7,
    style: 'warm',
    note: 'Thank you! Final exports without watermark are delivered once paid.',
    items: [['YouTube video edit (10–15 min)', 320], ['Short-form clips pack (10)', 400], ['Promo video (60 sec)', 850], ['Colour grading and sound mix', 180]],
  }),
  consultant: T('Consultant', 'Business strategy, market research', {
    retainer: 'advisory retainer',
    terms: 30,
    style: 'neutral',
    note: 'Thank you for the engagement. Payment is due within the agreed terms.',
    items: [['Strategy session (half day)', 1100], ['Market research report', 2400], ['Advisory (per hour)', 180], ['Competitor analysis', 1500]],
  }),
  photographer: T('Photographer', 'Commercial photography', {
    retainer: 'monthly content shoot',
    terms: 7,
    style: 'warm',
    note: 'Thank you! Full-resolution images and the usage licence are released once paid.',
    items: [['Product shoot (half day)', 900], ['Edited photos (per image)', 25], ['Headshot session', 350], ['Usage licence (1 year)', 400]],
  }),
  virtual_assistant: T('Virtual Assistant', 'Administrative support', {
    retainer: 'monthly support plan',
    terms: 7,
    style: 'brief',
    note: 'Thank you for your business. Hours are billed as logged in the shared tracker.',
    items: [['Admin support (per hour)', 35], ['Inbox and calendar management (monthly)', 600], ['Data entry (per hour)', 30], ['Travel booking', 75]],
  }),
  other: T('Other', 'Something else (tell us what)', {
    retainer: 'monthly retainer',
    terms: 15,
    style: 'warm',
    note: 'Thank you for your business. Payment is due by the date above.',
    items: [['Professional services (per hour)', 75], ['Project fee', 1000], ['Consultation', 150], ['Materials and expenses', 100]],
  }),
};

// older saved settings used broader types; map them onto the closest profession
const LEGACY = { freelancer: 'graphic_designer', agency: 'digital_marketer', consulting: 'consultant', clinic: 'other', tutor: 'other', trades: 'other' };

export const normalType = (key) => (BUSINESS_TYPES[key] ? key : LEGACY[key] || 'graphic_designer');
export const typeOf = (key) => BUSINESS_TYPES[normalType(key)];

/** Profession label for prompts and the UI, using the user's own words for "Other". */
export function professionLabel(key, other) {
  const k = normalType(key);
  return k === 'other' && other ? other : BUSINESS_TYPES[k].label;
}

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
