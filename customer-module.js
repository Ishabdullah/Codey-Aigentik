// customer-module.js — Restoricon Customer Intake, Sales & Support Module
// Comprehensive customer lifecycle management for Restoricon, LLC:
// Inquiry -> Qualification -> Project Assessment -> Estimate Scheduling ->
// Support -> Change Requests -> Escalations -> Human Handoff -> CRM State Tracking.

import config from './config.json' with { type: 'json' };
import log from './logger.js';

const CORE_API_BASE_URL = config.core_api?.base_url;
const CORE_API_TOKEN = config.core_api?.token;
const LIST_LIMIT = 1000;

// --- Restoricon Core Positioning & Context ---
export const RESTORICON_INFO = {
  company_name: 'Restoricon, LLC',
  description: 'Restoricon, LLC is a Connecticut residential remodeling, restoration, repair, and general contracting company focused on helping homeowners and property owners with construction, renovation, repair, and restoration projects.',
  service_area: 'Connecticut, with a focus on Hartford County and surrounding areas.',
  launch_phase: 'slow-launch phase building its customer and subcontractor network ahead of its planned January 2027 operational ramp-up',
  contact_tone: 'Professional, clear, helpful, calm, conversational, concise, and honest.',
  core_principle: 'The goal isn’t to sell every customer. The goal is to understand the customer’s problem, determine whether Restoricon can help, and move the customer to the correct next step.'
};

// --- Taxonomies & Enums ---

export const CUSTOMER_CATEGORIES = {
  NEW_CUSTOMER: 'NEW_CUSTOMER',
  EXISTING_CUSTOMER: 'EXISTING_CUSTOMER',
  PROPERTY_OWNER: 'PROPERTY_OWNER',
  PROPERTY_MANAGER: 'PROPERTY_MANAGER',
  REAL_ESTATE_PROFESSIONAL: 'REAL_ESTATE_PROFESSIONAL',
  INVESTOR: 'INVESTOR',
  INSURANCE_RELATED: 'INSURANCE_RELATED',
  COMMERCIAL_INQUIRY: 'COMMERCIAL_INQUIRY',
  SUBCONTRACTOR: 'SUBCONTRACTOR',
  SUPPLIER: 'SUPPLIER',
  OTHER: 'OTHER'
};

export const PROJECT_CATEGORIES = {
  REMODELING: 'remodeling',
  GENERAL_REPAIRS: 'general_repairs',
  EXTERIOR: 'exterior',
  RESTORATION: 'restoration',
  OTHER: 'other'
};

export const PROJECT_SUBTYPES = {
  // Remodeling
  KITCHEN: 'kitchen_remodeling',
  BATHROOM: 'bathroom_remodeling',
  BASEMENT: 'basement_finishing',
  WHOLE_HOUSE: 'whole_house_remodeling',
  ROOM_ADDITION: 'room_addition',
  INTERIOR_RENOVATION: 'interior_renovation',
  EXTERIOR_RENOVATION: 'exterior_renovation',
  FLOORING: 'flooring',
  PAINTING: 'painting',
  CABINETS: 'cabinets',
  COUNTERTOPS: 'countertops',
  DOORS: 'doors',
  WINDOWS: 'windows',
  TRIM: 'trim',
  DECKS: 'decks',
  PORCHES: 'porches',
  GARAGES: 'garages',
  ATTICS: 'attics',

  // General Repairs
  DRYWALL_REPAIR: 'drywall_repair',
  FLOORING_REPAIR: 'flooring_repair',
  DOOR_REPAIR: 'door_repair',
  WINDOW_REPAIR: 'window_repair',
  DECK_REPAIR: 'deck_repair',
  EXTERIOR_REPAIR: 'exterior_repair',
  STRUCTURAL_REPAIR: 'structural_repair',
  PROPERTY_MAINTENANCE: 'property_maintenance',
  PUNCH_LIST: 'punch_list',

  // Exterior
  ROOFING: 'roofing',
  SIDING: 'siding',
  GUTTERS: 'gutters',
  FENCES: 'fences',
  CONCRETE: 'concrete',
  MASONRY: 'masonry',
  LANDSCAPING: 'landscaping',
  EXTERIOR_PAINTING: 'exterior_painting',
  PRESSURE_WASHING: 'pressure_washing',

  // Restoration
  WATER_DAMAGE: 'water_damage',
  STORM_DAMAGE: 'storm_damage',
  FIRE_SMOKE_DAMAGE: 'fire_smoke_damage',
  MOLD_REMEDIATION: 'mold_related',
  EMERGENCY_REPAIR: 'emergency_repair',
  PROPERTY_CLEANUP: 'property_cleanup',
  DAMAGE_ASSESSMENT: 'damage_assessment_coordination',

  OTHER: 'other'
};

export const PROPERTY_TYPES = {
  SINGLE_FAMILY: 'Single-family',
  MULTI_FAMILY: 'Multi-family',
  CONDO: 'Condo',
  TOWNHOUSE: 'Townhouse',
  RENTAL_PROPERTY: 'Rental property',
  INVESTMENT_PROPERTY: 'Investment property',
  COMMERCIAL: 'Commercial',
  OTHER: 'Other'
};

export const LEAD_STATUSES = {
  NEW: 'NEW',
  CONTACTED: 'CONTACTED',
  RESPONDED: 'RESPONDED',
  QUALIFICATION: 'QUALIFICATION',
  QUALIFIED: 'QUALIFIED',
  APPOINTMENT_REQUESTED: 'APPOINTMENT_REQUESTED',
  APPOINTMENT_SCHEDULED: 'APPOINTMENT_SCHEDULED',
  ESTIMATE_PENDING: 'ESTIMATE_PENDING',
  ESTIMATE_COMPLETED: 'ESTIMATE_COMPLETED',
  PROPOSAL_SENT: 'PROPOSAL_SENT',
  DECISION_PENDING: 'DECISION_PENDING',
  WON: 'WON',
  LOST: 'LOST',
  FOLLOW_UP: 'FOLLOW_UP',
  CUSTOMER_NOT_READY: 'CUSTOMER_NOT_READY',
  OUT_OF_SERVICE_AREA: 'OUT_OF_SERVICE_AREA',
  HUMAN_REVIEW: 'HUMAN_REVIEW',
  DNC: 'DNC'
};

export const LEAD_SCORES = {
  HOT: 'HOT',
  WARM: 'WARM',
  COLD: 'COLD',
  UNQUALIFIED: 'UNQUALIFIED'
};

export const SUPPORT_CATEGORIES = {
  PROJECT_UPDATE: 'PROJECT_UPDATE',
  SCHEDULING: 'SCHEDULING',
  BILLING: 'BILLING',
  CHANGE_REQUEST: 'CHANGE_REQUEST',
  QUALITY_CONCERN: 'QUALITY_CONCERN',
  DAMAGE: 'DAMAGE',
  COMPLAINT: 'COMPLAINT',
  GENERAL_QUESTION: 'GENERAL_QUESTION'
};

// --- Approved Standard Greetings & Scripts ---

export const INITIAL_GREETING =
  "Thank you for contacting Restoricon. I'd be happy to help you with your project and gather some information so we can determine the best next step. What type of work are you looking to have done?";

export const EMERGENCY_LIFE_SAFETY_MESSAGE =
  "If you are in immediate danger, please move to a safe location and contact the appropriate emergency service.";

export const APPROVED_FAQS = [
  {
    topic: 'service_area',
    question: 'Where do you work / What areas do you serve?',
    answer: 'Restoricon serves Connecticut, with a focus on Hartford County and surrounding areas.'
  },
  {
    topic: 'services_offered',
    question: 'What services do you offer?',
    answer: 'Restoricon provides residential remodeling, repairs, restoration, and general contracting services. We can help with projects ranging from individual rooms and repairs to larger residential renovations.'
  },
  {
    topic: 'old_houses',
    question: 'Do you work on old houses / historic homes?',
    answer: 'Yes, residential renovation and repair projects can include older homes. The appropriate scope depends on the property\'s existing conditions.'
  },
  {
    topic: 'small_jobs',
    question: 'Do you do small jobs / handyman work?',
    answer: 'We consider projects based on scope, location, scheduling, and current availability. I can collect the details and have Restoricon determine whether the project is a fit.'
  },
  {
    topic: 'rentals_and_property_managers',
    question: 'Do you work on rental properties / with property managers?',
    answer: 'Restoricon can work with property owners and property managers on residential repair, remodeling, and restoration projects, subject to project requirements.'
  },
  {
    topic: 'investors',
    question: 'Do you work with real estate investors / flippers?',
    answer: 'Yes, Restoricon can work with property owners and investors on residential renovation and repair projects.'
  },
  {
    topic: 'pricing_general',
    question: 'How much will this project cost / Can you give me a price right now?',
    answer: 'The cost depends on the scope, materials, existing conditions, labor, permits, and other project requirements. We\'d need to understand the project and, when appropriate, evaluate the property before providing an accurate estimate.'
  },
  {
    topic: 'price_over_phone',
    question: 'Can you give me an estimate over the phone?',
    answer: 'We can collect the project details by phone, but the appropriate estimate process depends on the type and scope of work.'
  },
  {
    topic: 'why_no_instant_price',
    question: 'Why can\'t you give me a price right now?',
    answer: 'Because every property and project is different. We don\'t want to give you a number that turns out to be inaccurate. The scope and existing conditions need to be understood before Restoricon can provide an appropriate estimate.'
  },
  {
    topic: 'price_matching',
    question: 'Can you beat another contractor\'s price?',
    answer: 'Restoricon can review the scope and proposal, but we don\'t automatically match or beat another contractor\'s price. Our team can evaluate the project based on the actual scope and requirements.'
  },
  {
    topic: 'free_estimates',
    question: 'Do you provide free estimates?',
    answer: 'Restoricon can confirm the applicable estimate process and options based on the specific scope, type, and location of your project.'
  },
  {
    topic: 'permits',
    question: 'Will I need a permit for this work?',
    answer: 'Permit requirements depend on the specific work and location. Restoricon can evaluate the project and determine what permitting steps may be required.'
  },
  {
    topic: 'insurance_work',
    question: 'Do you work with insurance companies / claims?',
    answer: 'Yes, Restoricon works with customers on restoration-related projects and can discuss the process for your situation. Insurance coverage is determined by your insurance company and policy.'
  },
  {
    topic: 'why_choose_restoricon',
    question: 'Why should I choose Restoricon?',
    answer: 'Our goal is to provide professional project coordination, reliable workmanship through qualified professionals, clear communication, and a straightforward customer experience from the initial assessment through completion.'
  },
  {
    topic: 'referral_bonuses',
    question: 'Do you offer referral bonuses?',
    answer: 'I can have Restoricon provide you with the current referral information and policies.'
  }
];

export const APPROVED_OBJECTIONS = {
  multiple_estimates:
    "That's completely understandable. We encourage customers to choose the contractor they feel is the right fit for their project. We'd be happy to provide Restoricon's assessment and proposal for you to consider.",
  price_too_high:
    "I understand. If you'd like, I can have the Restoricon team review the scope with you so you understand what is included in the proposal.",
  need_to_think:
    "Absolutely. Would you like us to follow up with you on a particular date?",
  not_ready_yet:
    "No problem at all. When are you thinking about starting the project?",
  already_working_with_someone:
    "Understood. If anything changes or you need assistance down the road with future projects, Restoricon is here to help."
};

// --- Question Banks by Specialty ---

export const QUALIFICATION_QUESTIONS = {
  first_qualification: [
    'What type of work is needed?',
    'What is the property address (including town)?',
    'Is this a residential property?',
    'Are you the property owner?',
    'Is the property currently occupied?',
    'What are you hoping to accomplish with this project?',
    'Is this a planned improvement or an active problem?',
    'How soon are you looking to have the work done?'
  ],
  remodeling: {
    kitchen: [
      'Are you looking for a full remodel or partial remodel?',
      'What specific items would you like changed (cabinets, countertops, flooring, appliances, lighting)?',
      'Are you considering any layout or wall changes?',
      'Do you have a preferred style or materials already selected?',
      'Do you have any existing drawings, plans, or inspiration photos?'
    ],
    bathroom: [
      'Is this a full bathroom remodel or specific updates/repairs?',
      'Are you looking to replace the tub, shower, vanity, toilet, or tile?',
      'Will there be any plumbing or electrical layout changes?',
      'Are there any accessibility requirements or specific style preferences?'
    ],
    basement: [
      'Is the basement currently finished, partially finished, or unfinished?',
      'What is the approximate square footage of the space?',
      'What rooms or features are you planning (bedroom, bathroom, living area, office, storage)?',
      'Has there been any current or past moisture or water intrusion in the basement?'
    ],
    whole_house: [
      'Which specific areas of the home will be included in the remodel?',
      'Will you be living in the property during construction?',
      'Are architectural plans or permits already in place, or will they be needed?',
      'What is your target completion timeframe?'
    ]
  },
  exterior: {
    roofing: [
      'Are you looking for a full roof replacement or a repair?',
      'What type of roofing material is currently on the home, and approximately how old is it?',
      'What symptoms are you seeing (active leaks, missing shingles, storm damage)?',
      'Do you happen to have any photos of the roof or interior leaks?'
    ],
    siding: [
      'Is this a repair or a full exterior siding replacement?',
      'What material is currently on the house (vinyl, wood, cedar, aluminum, fiber cement)?',
      'Have you noticed any water intrusion, soft wood, or recent storm damage?',
      'Are you looking to keep the same style and color or change to a different material?'
    ],
    windows_doors: [
      'Are you looking for replacements or repairs?',
      'Approximately how many windows or doors are involved?',
      'Are there active drafts, leaks, or difficulty operating them?',
      'Is energy efficiency or a specific style/material a priority?'
    ]
  },
  restoration: {
    water_damage: [
      'Where is the water coming from, and is the source currently stopped?',
      'When did the water intrusion occur?',
      'What areas or rooms of the home are affected (floors, walls, ceilings, basement)?',
      'Is there standing water or visible moisture?',
      'Has electricity or structural drywall been affected?',
      'Has an insurance claim been opened or do you plan to file one?'
    ],
    fire_smoke: [
      'When did the incident occur?',
      'Is the property currently safe to enter?',
      'What areas were affected by fire, smoke, or water from extinguishing it?',
      'Was the fire department involved, and has an insurance claim been opened?',
      'Do you have an adjuster assigned or photos/documentation?'
    ],
    storm_damage: [
      'What type of storm occurred and when did the damage happen?',
      'What exterior or interior areas were affected (roof, siding, gutters, windows, water intrusion)?',
      'Have you taken photos of the damage?',
      'Have you contacted your homeowner insurance company yet?'
    ],
    mold_related: [
      'Where is the suspected area located, and what symptoms or visible signs are you seeing?',
      'Is there a current or previous water leak or moisture issue in that area?',
      'Has any testing or air quality inspection been performed?'
    ]
  }
};

// --- Emergency & Escalation Keywords ---

const EMERGENCY_KEYWORDS = [
  'flooding', 'flood', 'standing water', 'water gushing', 'burst pipe', 'pipe burst',
  'active leak', 'leaking actively', 'ceiling collapsing', 'roof collapsed',
  'collapsing', 'collapse', 'caved in', 'cave-in', 'structural damage',
  'fire', 'smoke', 'burning', 'gas smell', 'smell gas', 'gas leak', 'sparks',
  'electrical hazard', 'live wire', 'structural collapse', 'beam cracked',
  'foundation collapsing', 'emergency', 'immediate danger', 'hazard'
];

const SWEARING_KEYWORDS = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'bastard', 'dumbass', 'dumb fuck'];

const ESCALATION_KEYWORDS = [
  'lawyer', 'attorney', 'sue', 'lawsuit', 'litigation', 'legal action',
  'better business bureau', 'bbb', 'attorney general', 'dcp', 'consumer protection',
  'insurance dispute', 'denied claim', 'fraud', 'scam', 'police',
  'demand refund', 'unauthorized charge', 'stolen', 'media', 'reporter', 'news',
  'speak to the owner', 'speak to a human', 'real person', 'talk to human',
  'manager', 'boss', 'supervisor', 'executive'
];

// --- Storage / CRM Operations (Core API) ---

async function coreRequest(method, urlPath, { query, body } = {}) {
  if (!CORE_API_BASE_URL || !CORE_API_TOKEN) {
    throw new Error('customer-module: config.core_api.base_url/token not configured');
  }
  const url = new URL(urlPath, CORE_API_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CORE_API_TOKEN}`
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    log.error('customer-module', 'Core API request failed', { method, path: urlPath, error: e.message });
    throw e;
  }
  let data = null;
  let parseError = null;
  try {
    data = await response.json();
  } catch (e) {
    parseError = e;
  }
  return { status: response.status, ok: response.ok && !parseError, data, parseError };
}

export function mapCoreToJS(coreObj) {
  if (!coreObj) return null;
  const custom = coreObj.custom_fields || {};
  const fullName = `${coreObj.first_name || ''} ${coreObj.last_name || ''}`.trim() || 'Prospective Customer';

  const jsObj = {
    id: coreObj.id,
    customer_id: coreObj.external_id || (coreObj.id ? `CUST-${coreObj.id}` : null),
    customer_name: custom.customer_name || fullName,
    preferred_name: custom.preferred_name || null,
    first_name: coreObj.first_name,
    last_name: coreObj.last_name,
    company_name: coreObj.company_name || null,
    phone: coreObj.phone || null,
    email: coreObj.email || null,
    property_address: custom.property_address || coreObj.service_address || coreObj.mailing_address || null,
    service_address: coreObj.service_address || null,
    mailing_address: coreObj.mailing_address || null,
    city: custom.city || null,
    state: custom.state || 'CT',
    zip: custom.zip || null,
    property_type: custom.property_type || PROPERTY_TYPES.SINGLE_FAMILY,
    owner_status: custom.owner_status ?? true,
    occupancy_status: custom.occupancy_status || 'Occupied',

    customer_category: custom.customer_category || (coreObj.customer_type === 'commercial' ? CUSTOMER_CATEGORIES.COMMERCIAL_INQUIRY : CUSTOMER_CATEGORIES.NEW_CUSTOMER),
    project_category: custom.project_category || PROJECT_CATEGORIES.REMODELING,
    project_type: custom.project_type || null,
    project_description: custom.project_description || null,
    customer_goal: custom.customer_goal || null,
    rooms_affected: custom.rooms_affected || [],
    approximate_size: custom.approximate_size || null,
    materials_requested: custom.materials_requested || null,
    design_needed: custom.design_needed ?? false,

    project_urgency: custom.project_urgency || 'Standard',
    desired_start_date: custom.desired_start_date || null,
    desired_completion_date: custom.desired_completion_date || null,
    customer_budget: custom.customer_budget || null,

    insurance_related: custom.insurance_related ?? false,
    insurance_company: custom.insurance_company || null,
    claim_number: custom.claim_number || null,
    adjuster: custom.adjuster || null,
    incident_date: custom.incident_date || null,

    photos_received: custom.photos_received || [],
    documents_received: custom.documents_received || [],

    lead_source: custom.lead_source || coreObj.customer_source || 'inbound',
    lead_status: custom.lead_status || (coreObj.status ? coreObj.status.toUpperCase() : LEAD_STATUSES.NEW),
    lead_score: custom.lead_score || LEAD_SCORES.HOT,

    appointment_date: custom.appointment_date || null,
    appointment_time: custom.appointment_time || null,
    appointment_status: custom.appointment_status || null,

    last_contact: coreObj.last_contact_at || custom.last_contact || null,
    next_followup: coreObj.next_followup_at || custom.next_followup || null,
    contact_preference: custom.contact_preference || 'sms',
    best_contact_time: custom.best_contact_time || null,

    customer_notes: custom.customer_notes || (coreObj.notes ? [coreObj.notes] : []),
    dnc_status: custom.dnc_status ?? false,
    escalation_status: custom.escalation_status || null,
    created_at: coreObj.created_at || custom.created_at || new Date().toISOString(),
    updated_at: custom.updated_at || coreObj.created_at || new Date().toISOString(),
    tags: coreObj.tags || [],
    custom_fields: custom
  };

  return jsObj;
}

export function mapJSToCore(jsObj) {
  if (!jsObj) return null;

  let firstName = jsObj.first_name || '';
  let lastName = jsObj.last_name || '';
  if (!firstName && !lastName && jsObj.customer_name) {
    const parts = jsObj.customer_name.trim().split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }
  if (!firstName && !lastName) {
    firstName = 'Prospective';
    lastName = 'Customer';
  }

  const customFields = {
    ...(jsObj.custom_fields || {}),
    customer_name: jsObj.customer_name || `${firstName} ${lastName}`.trim(),
    preferred_name: jsObj.preferred_name || null,
    property_address: jsObj.property_address || null,
    city: jsObj.city || null,
    state: jsObj.state || 'CT',
    zip: jsObj.zip || null,
    property_type: jsObj.property_type || PROPERTY_TYPES.SINGLE_FAMILY,
    owner_status: jsObj.owner_status ?? true,
    occupancy_status: jsObj.occupancy_status || 'Occupied',

    customer_category: jsObj.customer_category || CUSTOMER_CATEGORIES.NEW_CUSTOMER,
    project_category: jsObj.project_category || PROJECT_CATEGORIES.REMODELING,
    project_type: jsObj.project_type || null,
    project_description: jsObj.project_description || null,
    customer_goal: jsObj.customer_goal || null,
    rooms_affected: jsObj.rooms_affected || [],
    approximate_size: jsObj.approximate_size || null,
    materials_requested: jsObj.materials_requested || null,
    design_needed: jsObj.design_needed ?? false,

    project_urgency: jsObj.project_urgency || 'Standard',
    desired_start_date: jsObj.desired_start_date || null,
    desired_completion_date: jsObj.desired_completion_date || null,
    customer_budget: jsObj.customer_budget || null,

    insurance_related: jsObj.insurance_related ?? false,
    insurance_company: jsObj.insurance_company || null,
    claim_number: jsObj.claim_number || null,
    adjuster: jsObj.adjuster || null,
    incident_date: jsObj.incident_date || null,

    photos_received: jsObj.photos_received || [],
    documents_received: jsObj.documents_received || [],

    lead_source: jsObj.lead_source || 'inbound',
    lead_status: jsObj.lead_status || LEAD_STATUSES.NEW,
    lead_score: jsObj.lead_score || LEAD_SCORES.HOT,

    appointment_date: jsObj.appointment_date || null,
    appointment_time: jsObj.appointment_time || null,
    appointment_status: jsObj.appointment_status || null,

    last_contact: jsObj.last_contact || null,
    next_followup: jsObj.next_followup || null,
    contact_preference: jsObj.contact_preference || 'sms',
    best_contact_time: jsObj.best_contact_time || null,

    customer_notes: jsObj.customer_notes || [],
    dnc_status: jsObj.dnc_status ?? false,
    escalation_status: jsObj.escalation_status || null,
    created_at: jsObj.created_at || new Date().toISOString(),
    updated_at: jsObj.updated_at || new Date().toISOString()
  };

  let notes = jsObj.notes;
  if (!notes && Array.isArray(jsObj.customer_notes) && jsObj.customer_notes.length > 0) {
    notes = jsObj.customer_notes.join('\n');
  }

  const coreObj = {
    id: jsObj.id || undefined,
    external_id: jsObj.customer_id || undefined,
    first_name: firstName,
    last_name: lastName,
    company_name: jsObj.company_name || null,
    phone: jsObj.phone || null,
    email: jsObj.email || null,
    mailing_address: jsObj.mailing_address || jsObj.property_address || null,
    service_address: jsObj.service_address || jsObj.property_address || null,
    customer_type: jsObj.customer_type || (jsObj.customer_category === 'COMMERCIAL_INQUIRY' || jsObj.property_type === 'Commercial' ? 'commercial' : 'residential'),
    customer_source: jsObj.customer_source || jsObj.lead_source || null,
    status: jsObj.status || (jsObj.lead_status === 'WON' ? 'active' : jsObj.lead_status === 'LOST' ? 'lost' : 'lead'),
    tags: jsObj.tags || [],
    notes: notes || null,
    custom_fields: customFields,
    created_at: jsObj.created_at || undefined,
    last_contact_at: jsObj.last_contact || jsObj.last_contact_at || null,
    next_followup_at: jsObj.next_followup || jsObj.next_followup_at || null
  };

  return coreObj;
}

export async function loadCustomers() {
  const { ok, status, data, parseError } = await coreRequest('GET', '/api/v1/customers', {
    query: { limit: LIST_LIMIT }
  });
  if (!ok) {
    throw new Error(`Core customers list failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  }
  return (data.customers || []).map(mapCoreToJS);
}

export function saveCustomers(customers) {
  // Deprecated: mutations write through to Core API directly.
  return true;
}

export function generateCustomerId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `CUST-${timestamp}-${randomPart}`;
}

export async function findCustomer(query, customersList = null) {
  if (!query) return null;
  if (customersList) {
    const q = String(query).toLowerCase().trim();
    const digits = q.replace(/\D/g, '');

    return customersList.find(c => {
      if (c.customer_id && c.customer_id.toLowerCase() === q) return true;
      if (c.phone && digits.length >= 7 && c.phone.replace(/\D/g, '').includes(digits)) return true;
      if (c.email && c.email.toLowerCase() === q) return true;
      if (c.customer_name && c.customer_name.toLowerCase().includes(q)) return true;
      if (c.property_address && c.property_address.toLowerCase().includes(q)) return true;
      return false;
    }) || null;
  }

  const { ok, data } = await coreRequest('GET', '/api/v1/customers/search', { query: { q: String(query) } });
  if (ok && data?.customer) {
    return mapCoreToJS(data.customer);
  }
  return null;
}

export async function getCustomerById(customerId) {
  if (!customerId) return null;
  if (typeof customerId === 'number' || /^\d+$/.test(String(customerId))) {
    const { ok, data } = await coreRequest('GET', `/api/v1/customers/${customerId}`);
    if (ok && data?.customer) {
      return mapCoreToJS(data.customer);
    }
  }
  return await findCustomer(customerId);
}

export async function createOrUpdateCustomer(leadData) {
  const now = new Date().toISOString();
  let externalId = leadData.customer_id;
  let existing = null;

  if (!externalId) {
    existing = (leadData.phone || leadData.email || leadData.customer_name)
      ? await findCustomer(leadData.phone || leadData.email || leadData.customer_name)
      : null;
    if (existing && existing.customer_id) {
      externalId = existing.customer_id;
    } else {
      externalId = generateCustomerId();
    }
  }

  const record = {
    ...(existing || {}),
    ...leadData,
    customer_id: externalId,
    customer_name: leadData.customer_name || existing?.customer_name || 'Prospective Customer',
    preferred_name: leadData.preferred_name ?? existing?.preferred_name ?? null,
    phone: leadData.phone ?? existing?.phone ?? null,
    email: leadData.email ?? existing?.email ?? null,
    property_address: leadData.property_address ?? existing?.property_address ?? null,
    city: leadData.city ?? existing?.city ?? null,
    state: leadData.state ?? existing?.state ?? 'CT',
    zip: leadData.zip ?? existing?.zip ?? null,
    property_type: leadData.property_type ?? existing?.property_type ?? PROPERTY_TYPES.SINGLE_FAMILY,
    owner_status: leadData.owner_status ?? existing?.owner_status ?? true,
    occupancy_status: leadData.occupancy_status ?? existing?.occupancy_status ?? 'Occupied',

    customer_category: leadData.customer_category ?? existing?.customer_category ?? CUSTOMER_CATEGORIES.NEW_CUSTOMER,
    project_category: leadData.project_category ?? existing?.project_category ?? PROJECT_CATEGORIES.REMODELING,
    project_type: leadData.project_type ?? existing?.project_type ?? null,
    project_description: leadData.project_description ?? existing?.project_description ?? null,
    customer_goal: leadData.customer_goal ?? existing?.customer_goal ?? null,
    rooms_affected: leadData.rooms_affected ?? existing?.rooms_affected ?? [],
    approximate_size: leadData.approximate_size ?? existing?.approximate_size ?? null,
    materials_requested: leadData.materials_requested ?? existing?.materials_requested ?? null,
    design_needed: leadData.design_needed ?? existing?.design_needed ?? false,

    project_urgency: leadData.project_urgency ?? existing?.project_urgency ?? 'Standard',
    desired_start_date: leadData.desired_start_date ?? existing?.desired_start_date ?? null,
    desired_completion_date: leadData.desired_completion_date ?? existing?.desired_completion_date ?? null,
    customer_budget: leadData.customer_budget ?? existing?.customer_budget ?? null,

    insurance_related: leadData.insurance_related ?? existing?.insurance_related ?? false,
    insurance_company: leadData.insurance_company ?? existing?.insurance_company ?? null,
    claim_number: leadData.claim_number ?? existing?.claim_number ?? null,
    adjuster: leadData.adjuster ?? existing?.adjuster ?? null,
    incident_date: leadData.incident_date ?? existing?.incident_date ?? null,

    photos_received: leadData.photos_received ?? existing?.photos_received ?? [],
    documents_received: leadData.documents_received ?? existing?.documents_received ?? [],

    lead_source: leadData.lead_source ?? existing?.lead_source ?? 'inbound',
    lead_status: leadData.lead_status ?? existing?.lead_status ?? LEAD_STATUSES.NEW,
    lead_score: LEAD_SCORES.HOT,

    appointment_date: leadData.appointment_date ?? existing?.appointment_date ?? null,
    appointment_time: leadData.appointment_time ?? existing?.appointment_time ?? null,
    appointment_status: leadData.appointment_status ?? existing?.appointment_status ?? null,

    last_contact: now,
    next_followup: leadData.next_followup ?? existing?.next_followup ?? null,
    contact_preference: leadData.contact_preference ?? existing?.contact_preference ?? 'sms',
    best_contact_time: leadData.best_contact_time ?? existing?.best_contact_time ?? null,

    customer_notes: leadData.customer_notes ?? existing?.customer_notes ?? [],
    dnc_status: leadData.dnc_status ?? existing?.dnc_status ?? false,
    escalation_status: leadData.escalation_status ?? existing?.escalation_status ?? null,
    created_at: existing?.created_at || now,
    updated_at: now
  };

  record.lead_score = calculateLeadScore(record);
  const mapped = mapJSToCore(record);
  const { ok, data: resData, status, parseError } = await coreRequest('POST', '/api/v1/customers/upsert', { body: mapped });

  if (!ok) {
    log.error('customer-module', 'Failed to upsert customer', { status });
    throw new Error(`Core customer upsert failed (${status}): ${resData?.error || parseError?.message || 'unknown error'}`);
  }

  const finalRecord = resData?.customer ? mapCoreToJS(resData.customer) : mapCoreToJS(resData) || record;
  log.info('customer-module', existing ? 'Updated customer record' : 'Created new customer record', { customerId: finalRecord.customer_id, name: finalRecord.customer_name });
  return finalRecord;
}

export async function updateCustomer(customerId, fields) {
  if (!customerId) return null;
  let existing = await getCustomerById(customerId);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...fields,
    updated_at: new Date().toISOString()
  };
  if (fields.customer_notes && Array.isArray(fields.customer_notes)) {
    updated.customer_notes = [...(existing.customer_notes || []), ...fields.customer_notes];
  }

  updated.lead_score = calculateLeadScore(updated);

  return await createOrUpdateCustomer(updated);
}

// --- Intelligence: Emergency & Escalation Detection ---

export function checkEmergencyKeywords(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return EMERGENCY_KEYWORDS.some(kw => lower.includes(kw));
}

export function checkEscalationKeywords(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return ESCALATION_KEYWORDS.some(kw => lower.includes(kw));
}

export function checkSwearing(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return SWEARING_KEYWORDS.some(kw => lower.includes(kw));
}

// --- Intelligence: Lead Scoring ---

export function calculateLeadScore(customer) {
  if (!customer) return LEAD_SCORES.COLD;

  if (customer.dnc_status) return LEAD_SCORES.UNQUALIFIED;
  if (customer.lead_status === LEAD_STATUSES.OUT_OF_SERVICE_AREA || customer.lead_status === LEAD_STATUSES.LOST) {
    return LEAD_SCORES.UNQUALIFIED;
  }

  let scorePoints = 0;

  // Clear project
  if (customer.project_type || customer.project_description) scorePoints += 2;
  // Owns property
  if (customer.owner_status === true) scorePoints += 2;
  // Service area (CT / Hartford county)
  if (customer.state === 'CT' || (customer.city && isConnecticutCity(customer.city))) scorePoints += 2;
  // Wants work soon or active damage
  if (customer.project_urgency === 'High' || customer.project_urgency === 'Immediate' || customer.insurance_related) scorePoints += 2;
  // Responsive / contact info present
  if (customer.phone && customer.email) scorePoints += 1;
  // Appointment interested or requested
  if (customer.lead_status === LEAD_STATUSES.APPOINTMENT_REQUESTED || customer.lead_status === LEAD_STATUSES.APPOINTMENT_SCHEDULED) scorePoints += 3;

  if (scorePoints >= 8) return LEAD_SCORES.HOT;
  if (scorePoints >= 4) return LEAD_SCORES.WARM;
  return LEAD_SCORES.COLD;
}

function isConnecticutCity(city) {
  const ctTowns = [
    'hartford', 'west hartford', 'east hartford', 'manchester', 'glastonbury',
    'wethersfield', 'newington', 'rocky hill', 'avon', 'simsbury', 'farmington',
    'bloomfield', 'windsor', 'south windsor', 'enfield', 'southington', 'bristol',
    'new britain', 'berlin', 'canton', 'granby', 'suffield', 'plainville',
    'middletown', 'cromwell', 'cheshire', 'waterbury', 'stamford', 'norwalk', 'danbury'
  ];
  return ctTowns.includes(city.toLowerCase().trim());
}

// --- Human Handoff Summary Formatter ---

export function formatHandoffSummary({
  customer,
  issue = 'Human review requested',
  urgency = 'Standard',
  whatCustomerWants = 'Assistance from Restoricon management team',
  informationCollected = null,
  nextAction = 'Follow up with customer'
}) {
  const custName = customer?.customer_name || 'Prospective Customer';
  const phone = customer?.phone || 'Not provided';
  const email = customer?.email || 'Not provided';
  const addr = customer?.property_address ? `${customer.property_address}, ${customer.city || ''} ${customer.state || 'CT'}` : 'Not provided';
  const project = customer?.project_description || customer?.project_type || customer?.project_category || 'General inquiry';
  const photos = customer?.photos_received?.length ? `${customer.photos_received.length} photo(s)` : 'None';
  const docs = customer?.documents_received?.length ? `${customer.documents_received.length} doc(s)` : 'None';
  const appt = customer?.appointment_date ? `${customer.appointment_date} ${customer.appointment_time || ''}` : 'Not scheduled';

  return [
    '🚨 RESTORICON HUMAN HANDOFF REQUIRED',
    '----------------------------------------',
    `CUSTOMER: ${custName} (${phone} | ${email})`,
    `PROPERTY: ${addr}`,
    `PROJECT: ${project}`,
    `ISSUE: ${issue}`,
    `URGENCY: ${urgency}`,
    `WHAT CUSTOMER WANTS: ${whatCustomerWants}`,
    `INFORMATION COLLECTED: ${informationCollected || (customer ? JSON.stringify({ category: customer.project_category, type: customer.project_type, urgency: customer.project_urgency }) : 'Initial contact')}`,
    `DOCUMENTS: ${docs}`,
    `PHOTOS: ${photos}`,
    `APPOINTMENT: ${appt}`,
    `NEXT ACTION: ${nextAction}`,
    '----------------------------------------'
  ].join('\n');
}

// --- System Prompt Builder for LLM Customer Agent ---

export function buildCustomerSystemPrompt({
  customer = null,
  channel = 'sms',
  agentName = 'Aigentik',
  ownerName = 'the Restoricon management team',
  appointmentContext = null
} = {}) {
  const isEmergency = customer?.escalation_status === 'EMERGENCY_REVIEW';
  const customerName = customer?.customer_name || 'the homeowner';
  const category = customer?.customer_category || CUSTOMER_CATEGORIES.NEW_CUSTOMER;
  const projectType = customer?.project_type || 'residential project';
  const leadStatus = customer?.lead_status || LEAD_STATUSES.NEW;

  return `You are ${agentName}, the customer service, sales intake, and project coordinator AI representative for Restoricon, LLC.

=== RESTORICON COMPANY POSITIONING ===
- Restoricon, LLC is a Connecticut residential remodeling, restoration, repair, and general contracting company focused on helping homeowners and property owners with construction, renovation, repair, and restoration projects.
- Primary service area: Connecticut, with a focus on Hartford County and surrounding areas.
- Restoricon is currently in a slow-launch phase building its customer and subcontractor network ahead of its planned January 2027 operational ramp-up.
- Core philosophy: The goal isn't to sell every customer. The goal is to understand the customer's problem, determine whether Restoricon can help, and move the customer to the correct next step.
- Operating Owner / Management: ${ownerName}.

=== CONVERSATION STYLE & RULES ===
- Communication tone: Professional, clear, helpful, calm, conversational, concise, and honest.
- Have a natural conversation. Do not bombard the customer with 20 questions at once. Ask 1 or 2 relevant, natural follow-up questions at a time.
- Channel: ${channel.toUpperCase()} (${channel === 'sms' ? 'Keep messages concise and mobile-friendly' : 'Use clear, well-structured email formatting'}).
- Contact Information: DO NOT ask for contact information (email, phone, address, etc.) if it is already provided in the "CURRENT CUSTOMER CONTEXT". Only ask to verify it when completing an appointment booking by reading back what you have and asking if it is correct or if they have corrections.
- Immediate Calls: If a customer asks for an immediate phone call (e.g. "Can I call right now"), inform them that all representatives are currently busy. Then, notify them of the next available slot on the schedule starting on the next business day (or whenever there is an opening).

=== STRICT MANDATORY SAFETY GUARDRAILS ===
1. NEVER INVENT PRICING OR GIVE DEFINITIVE PHONE ESTIMATES: Always explain that costs depend on scope, materials, existing conditions, labor, and permits.
2. NEVER DIAGNOSE REMOTELY: For roofing, mold, or structural concerns, state that a Restoricon professional needs to evaluate conditions on-site.
3. NEVER GUARANTEE INSURANCE CLAIM APPROVAL: Insurance coverage is determined by the customer's insurance carrier and policy.
4. NEVER DECLARE A STRUCTURE SAFE after a fire, flood, or severe storm.
5. NEVER PROMISE "WE'LL FIX IT" OR ADMIT LIABILITY for quality complaints or damage without human management review.
6. NEVER AUTHORIZE CHANGE ORDERS OR CONTRACT CANCELLATIONS independently.
7. NEVER GUESS: If you do not know the answer, say: "I don't want to give you incorrect information. Let me get that question to the appropriate Restoricon team member."

=== EMERGENCY PROTOCOL ===
If the customer mentions active flooding, water gushing, structural collapse hazard, gas smell, electrical fire, or immediate safety threat:
- Instruct them to get to safety and call emergency services (911) if in immediate danger.
- Switch tone to EMERGENCY_REVIEW and state that Restoricon management is being alerted immediately.

=== CURRENT CUSTOMER CONTEXT ===
- Customer Name: ${customerName}
- Category: ${category}
- Known Project: ${projectType}
- Lead Status: ${leadStatus}
- Known Address: ${customer?.property_address || 'Not provided yet'}
- Urgency: ${customer?.project_urgency || 'Standard'}
- Emergency Flag: ${isEmergency ? 'YES (EMERGENCY IN PROGRESS)' : 'NO'}
- Existing Appointment: ${appointmentContext || 'None on file'}

Respond professionally as ${agentName} for Restoricon. Advance the qualification, answer customer questions using approved information, and guide them to the proper next step. If an appointment is already on file, only bring it up when actually relevant to what the customer just asked — never propose or offer a new/different appointment yourself; that's handled by a separate scheduling flow.`;
}

// --- Customer Summaries & Pipeline Reports ---

export function formatCustomerSummary(customer) {
  if (!customer) return 'No customer record found.';

  const scoreEmoji = {
    HOT: '🔥',
    WARM: '☀️',
    COLD: '❄️',
    UNQUALIFIED: '⛔'
  }[customer.lead_score] || '📋';

  return [
    `👤 Customer Profile: ${customer.customer_name} [${customer.customer_id}]`,
    `----------------------------------------`,
    `Score: ${scoreEmoji} ${customer.lead_score || 'COLD'} | Status: ${customer.lead_status || 'NEW'}`,
    `Category: ${customer.customer_category || 'NEW_CUSTOMER'} | Owner: ${customer.owner_status ? 'Yes' : 'No'}`,
    `Phone: ${customer.phone || 'N/A'} | Email: ${customer.email || 'N/A'}`,
    `Address: ${customer.property_address || 'N/A'}, ${customer.city || ''} ${customer.state || 'CT'} ${customer.zip || ''}`,
    `Property Type: ${customer.property_type || 'Single-family'} | Occupied: ${customer.occupancy_status || 'Yes'}`,
    ``,
    `🛠️ Project Details:`,
    `Category: ${customer.project_category || 'Remodeling'} | Type: ${customer.project_type || 'General'}`,
    `Description: ${customer.project_description || 'N/A'}`,
    `Urgency: ${customer.project_urgency || 'Standard'} | Budget: ${customer.customer_budget || 'N/A'}`,
    `Timeline: Start ${customer.desired_start_date || 'Flexible'} / Target ${customer.desired_completion_date || 'Flexible'}`,
    `Insurance Related: ${customer.insurance_related ? `Yes (${customer.insurance_company || 'Carrier N/A'}, Claim #${customer.claim_number || 'N/A'})` : 'No'}`,
    ``,
    `📅 Scheduling & Follow-Up:`,
    `Appointment: ${customer.appointment_date ? `${customer.appointment_date} at ${customer.appointment_time || ''} (${customer.appointment_status || 'Pending'})` : 'None scheduled'}`,
    `Next Follow-Up: ${customer.next_followup || 'None scheduled'}`,
    `Escalation: ${customer.escalation_status || 'Normal'}`
  ].join('\n');
}

export async function formatCustomerPipelineReport() {
  const customers = await loadCustomers();
  if (customers.length === 0) {
    return 'No customers currently in the CRM pipeline.';
  }

  const byStatus = {};
  const byScore = { HOT: 0, WARM: 0, COLD: 0, UNQUALIFIED: 0 };
  let emergencyCount = 0;

  for (const c of customers) {
    const st = c.lead_status || 'NEW';
    byStatus[st] = (byStatus[st] || 0) + 1;

    const sc = c.lead_score || 'COLD';
    byScore[sc] = (byScore[sc] || 0) + 1;

    if (c.escalation_status === 'EMERGENCY_REVIEW') emergencyCount++;
  }

  const lines = [
    `📊 Restoricon Customer Pipeline Report (${customers.length} Total)`,
    `========================================`,
    `Lead Scores:`,
    `🔥 HOT: ${byScore.HOT || 0}  |  ☀️ WARM: ${byScore.WARM || 0}  |  ❄️ COLD: ${byScore.COLD || 0}  |  ⛔ UNQUALIFIED: ${byScore.UNQUALIFIED || 0}`,
    ``,
    `Status Breakdown:`
  ];

  for (const [st, count] of Object.entries(byStatus)) {
    lines.push(`• ${st}: ${count}`);
  }

  if (emergencyCount > 0) {
    lines.push(``);
    lines.push(`🚨 Active Emergency / Urgent Escalations: ${emergencyCount}`);
  }

  return lines.join('\n');
}

export async function formatCustomerFollowupList() {
  const customers = await loadCustomers();
  const followups = customers.filter(c => c.next_followup || c.lead_status === LEAD_STATUSES.FOLLOW_UP || c.lead_status === LEAD_STATUSES.DECISION_PENDING);

  if (followups.length === 0) {
    return '✅ No customer follow-ups currently due.';
  }

  const lines = [
    `📋 Restoricon Customer Follow-Up Queue (${followups.length})`,
    `========================================`
  ];

  for (const c of followups) {
    lines.push(`• ${c.customer_name} [${c.customer_id}] — Due: ${c.next_followup || 'Action Required'} | Status: ${c.lead_status} | Project: ${c.project_type || c.project_category || 'General'}`);
  }

  return lines.join('\n');
}
