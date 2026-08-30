// subcontractor-recruiter.js — Restoricon Subcontractor Recruitment, Qualification,
// and Pipeline Management Module for Aigentik-CLI.
//
// B2 task 4 write-through: this module used to store subcontractors in
// data/subcontractors.json. It now writes through to Restoricon Core's
// /api/v1/subcontractors* routes — Core is the single source of truth,
// Core-only, with no local-JSON fallback.

import config from './config.json' with { type: 'json' };
import log from './logger.js';
import * as contacts from './contacts.js';
import {
  normalizeTrade,
  extractAllTrades,
  getTradeDisplayName,
  getTradeSpecificQuestions,
  isRecognizedTrade
} from './trades.js';

const CORE_API_BASE_URL = config.core_api?.base_url;
const CORE_API_TOKEN = config.core_api?.token;
const LIST_LIMIT = 1000;

async function coreRequest(method, urlPath, { query, body } = {}) {
  if (!CORE_API_BASE_URL || !CORE_API_TOKEN) {
    throw new Error('subcontractor-recruiter: config.core_api.base_url/token not configured');
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
    log.error('subcontractor-recruiter', 'Core API request failed', { method, path: urlPath, error: e.message });
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

// Explicit Mapping for Core API (NEW-245)
// Core.external_id <-> JS.subcontractor_id
// Core.id <-> JS.id
// Core.last_contact_at <-> JS.last_contact
// Core 1/0/null <-> JS boolean/null for: w9_received, msa_signed, coi_received, msa_sent, workers_comp, license_required, general_liability.
function mapCoreToJS(coreObj) {
  if (!coreObj) return null;
  const jsObj = { ...coreObj };
  jsObj.subcontractor_id = coreObj.external_id || (coreObj.id ? `sub_${String(coreObj.id).padStart(4, '0')}` : null);
  jsObj.id = coreObj.id;
  jsObj.last_contact = coreObj.last_contact_at;
  
  const boolFields = [
    'w9_received', 'msa_signed', 'coi_received', 'msa_sent',
    'workers_comp', 'license_required', 'general_liability',
    'residential_experience', 'commercial_experience', 'emergency_availability'
  ];
  for (const field of boolFields) {
    if (coreObj[field] === 1 || coreObj[field] === true) jsObj[field] = true;
    else if (coreObj[field] === 0 || coreObj[field] === false) jsObj[field] = false;
    else jsObj[field] = null;
  }
  return jsObj;
}

function mapJSToCore(jsObj) {
  if (!jsObj) return null;
  const coreObj = { ...jsObj };
  coreObj.external_id = jsObj.subcontractor_id;
  coreObj.id = jsObj.id;
  coreObj.last_contact_at = jsObj.last_contact;
  
  const boolFields = [
    'w9_received', 'msa_signed', 'coi_received', 'msa_sent',
    'workers_comp', 'license_required', 'general_liability',
    'residential_experience', 'commercial_experience', 'emergency_availability'
  ];
  for (const field of boolFields) {
    if (jsObj[field] === true) coreObj[field] = 1;
    else if (jsObj[field] === false) coreObj[field] = 0;
    else if (jsObj[field] === null) coreObj[field] = null;
  }
  return coreObj;
}

// Qualification Status Taxonomy
const QUALIFICATION_STATUSES = {
  NEW_LEAD: 'NEW_LEAD',
  CONTACTED: 'CONTACTED',
  CONVERSATION_STARTED: 'CONVERSATION_STARTED',
  INTERESTED: 'INTERESTED',
  QUALIFICATION_IN_PROGRESS: 'QUALIFICATION_IN_PROGRESS',
  QUALIFIED_PENDING_DOCUMENTS: 'QUALIFIED_PENDING_DOCUMENTS',
  DOCUMENTS_REQUESTED: 'DOCUMENTS_REQUESTED',
  DOCUMENTS_PARTIALLY_RECEIVED: 'DOCUMENTS_PARTIALLY_RECEIVED',
  MSA_PENDING: 'MSA_PENDING',
  INSURANCE_PENDING: 'INSURANCE_PENDING',
  LICENSE_PENDING: 'LICENSE_PENDING',
  DOCUMENTS_UNDER_REVIEW: 'DOCUMENTS_UNDER_REVIEW',
  APPROVED_ONBOARDING: 'APPROVED_ONBOARDING',
  ONBOARDING_COMPLETE: 'ONBOARDING_COMPLETE',
  DECLINED: 'DECLINED',
  DO_NOT_CONTACT: 'DO_NOT_CONTACT',
  FOLLOW_UP_REQUESTED: 'FOLLOW_UP_REQUESTED'
};

// Conversational Recruitment Steps
const RECRUITMENT_STEPS = {
  OPENING: 'OPENING',
  COMPANY_INFO: 'COMPANY_INFO',
  TRADE_QUALIFICATION: 'TRADE_QUALIFICATION',
  TRADE_SPECIFIC: 'TRADE_SPECIFIC',
  EXPERIENCE: 'EXPERIENCE',
  SERVICE_AREA: 'SERVICE_AREA',
  AVAILABILITY: 'AVAILABILITY',
  LICENSING: 'LICENSING',
  INSURANCE: 'INSURANCE',
  ONBOARDING_MSA: 'ONBOARDING_MSA',
  DOCUMENTS_REQUEST: 'DOCUMENTS_REQUEST',
  QUALIFIED_REVIEW: 'QUALIFIED_REVIEW'
};

// Approved Restoricon Q&A Knowledge Base
const RECRUITER_FAQS = [
  {
    topic: 'company_identity',
    match: ['what kind of company', 'what is restoricon', 'who is restoricon', 'what do you do', 'tell me about restoricon'],
    answer: "Restoricon is a Connecticut residential remodeling, restoration, repair, and general contracting company."
  },
  {
    topic: 'why_contacting',
    match: ['why are you contacting me', 'why did you text me', 'why are you reaching out', 'what is this about'],
    answer: "We're building our subcontractor network ahead of our planned January 2027 ramp-up and are looking to establish relationships with reliable contractors."
  },
  {
    topic: 'work_right_now',
    match: ['do you have work right now', 'any jobs today', 'do you have work now', 'immediate work', 'ready to start today'],
    answer: "We're currently developing our project pipeline and subcontractor network. We're preparing for increased project activity beginning around January 2027."
  },
  {
    topic: 'work_volume',
    match: ['how much work will i get', 'how many jobs', 'project volume', 'steady work'],
    answer: "Project opportunities will depend on our workload, your trade, location, availability, qualifications, and project requirements. We don't guarantee a specific amount of work."
  },
  {
    topic: 'guaranteed_work',
    match: ['is work guaranteed', 'guarantee work', 'guaranteed jobs'],
    answer: "No. Joining the subcontractor network does not guarantee projects. It gives Restoricon the opportunity to consider you for projects that match your capabilities."
  },
  {
    topic: 'pay_rates',
    match: ['how much do you pay', 'what are your rates', 'payment terms', 'how do you pay', 'pay scale'],
    answer: "Project pricing and compensation are determined based on the specific scope of work and the agreement between Restoricon and the subcontractor."
  },
  {
    topic: 'contract_requirement',
    match: ['do i have to sign a contract', 'need a contract', 'subcontractor agreement', 'msa required'],
    answer: "Restoricon requires qualified subcontractors to complete its onboarding process, which includes the Master Subcontractor Agreement and required business, licensing, and insurance documentation."
  },
  {
    topic: 'insurance_requirement',
    match: ['why do you need my insurance', 'why insurance', 'is insurance required', 'coi needed'],
    answer: "We require appropriate documentation so Restoricon can verify that subcontractors meet the company's project and risk-management requirements."
  },
  {
    topic: 'license_requirement',
    match: ['why do you need my license', 'why license', 'license needed'],
    answer: "Where licensing is required for the work being performed, Restoricon needs to verify the applicable credentials before approving a subcontractor."
  },
  {
    topic: 'exclusivity',
    match: ['exclusive', 'do i have to work exclusively', 'can i work for other people', 'only work for restoricon'],
    answer: "Restoricon does not represent that joining the network requires exclusivity. Any specific contractual requirements would be addressed in the applicable agreement."
  },
  {
    topic: 'choose_jobs',
    match: ['can i choose which jobs', 'can i turn down work', 'do i have to take every job'],
    answer: "Project opportunities are offered based on project requirements, availability, location, qualifications, and other factors. Whether you accept a particular opportunity would depend on the applicable project arrangement."
  },
  {
    topic: 'service_areas',
    match: ['where does restoricon work', 'what towns do you cover', 'service area', 'what areas in ct'],
    answer: "Restoricon is focused on Connecticut residential projects, with an emphasis on Hartford County and surrounding areas."
  },
  {
    topic: 'outside_hartford',
    match: ['outside hartford county', 'fairfield', 'new haven', 'other counties'],
    answer: "Potentially, depending on the project and service area. Restoricon can discuss specific opportunities as they become available."
  },
  {
    topic: 'how_to_apply',
    match: ['how do i apply', 'how do i join', 'sign up', 'how to get started'],
    answer: "I'll collect your basic information and provide the next step in the Restoricon subcontractor onboarding process."
  }
];

// Approved Objection Handlers
const RECRUITER_OBJECTIONS = {
  already_busy: "I understand. We're actually reaching out ahead of time because we're building the network before our 2027 ramp-up. We can keep your information on file and reconnect when your schedule allows.",
  dont_need_work: "No problem. We appreciate your time. If your situation changes in the future, we'd be happy to reconnect.",
  send_email: "Absolutely. What's the best email address? I'll send you the information and follow up with you.",
  how_got_number: (source) => source
    ? `We came across your contact details via ${source} during our local trade research.`
    : "We found your contact information through local Connecticut trade directories and public business listings while researching contractors in your area.",
  are_you_contractor: "I'm contacting you on behalf of Restoricon regarding its subcontractor network. Restoricon's team handles the formal contracting and approval process.",
  who_owns_restoricon: "Restoricon, LLC is a locally managed Connecticut general contracting and restoration firm. I can have someone from Restoricon follow up with you with additional company background."
};

// Opening Script
const OPENING_SCRIPT = "Hi, I'm reaching out on behalf of Restoricon, a Connecticut residential remodeling, restoration, and general contracting company. We're currently building our network of qualified subcontractors ahead of our planned January 2027 ramp-up. We're looking to establish relationships with reliable contractors who may be interested in additional project opportunities as our workload grows. May I ask you a few questions about your company and the work you do?";

// Follow-up Script Templates
const FOLLOW_UP_TEMPLATES = {
  first_followup: (name, agent) => `Hi ${name || 'there'}, this is ${agent || 'Aigentik'} following up regarding Restoricon's subcontractor network. We're continuing to build our contractor network ahead of our January 2027 ramp-up. I wanted to see if you're still interested in learning more.`,
  second_followup: (name, agent) => `Hi ${name || 'there'}, just following up one more time regarding the Restoricon subcontractor opportunity. If you're interested, I can help you with the next step. If now isn't a good time, that's completely fine.`,
  document_request: "To continue the onboarding process, Restoricon will need the applicable business, licensing, insurance, tax, and agreement documentation. I'll provide the appropriate instructions for submitting those documents securely."
};

// ─── Storage (Core API) ─────────────────────────────────────────────────────

async function loadSubcontractors() {
  const { ok, status, data, parseError } = await coreRequest('GET', '/api/v1/subcontractors', {
    query: { limit: LIST_LIMIT }
  });
  if (!ok) {
    throw new Error(`Core subcontractors list failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  }
  return (data.subcontractors || []).map(mapCoreToJS);
}

function saveSubcontractors(data) {
  // Deprecated: mutations write through to Core API directly.
}

function generateSubcontractorId(existing = []) {
  const nums = existing
    .map(s => {
      const m = s.subcontractor_id?.match(/sub_(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return `sub_${String(max + 1).padStart(4, '0')}`;
}

async function getSubcontractorById(subcontractorId) {
  if (!subcontractorId) return null;
  if (typeof subcontractorId === 'number' || /^\d+$/.test(String(subcontractorId))) {
    const { ok, data } = await coreRequest('GET', `/api/v1/subcontractors/${subcontractorId}`);
    if (ok && data?.subcontractor) {
      return mapCoreToJS(data.subcontractor);
    }
  }
  const { ok, data } = await coreRequest('GET', '/api/v1/subcontractors', { query: { q: String(subcontractorId) } });
  if (ok && data?.subcontractor) {
    return mapCoreToJS(data.subcontractor);
  }
  return null;
}

async function findSubcontractor(identifier) {
  if (!identifier) return null;
  const { ok, data } = await coreRequest('GET', '/api/v1/subcontractors', { query: { q: String(identifier) } });
  if (ok && data?.subcontractor) {
    return mapCoreToJS(data.subcontractor);
  }
  return null;
}

async function createOrUpdateSubcontractorLead(data) {
  const now = new Date().toISOString();

  let externalId = data.subcontractor_id;
  if (!externalId) {
    const existing = (data.phone || data.email || data.contact_name) ? await findSubcontractor(data.phone || data.email || data.contact_name) : null;
    if (existing && existing.subcontractor_id) {
      externalId = existing.subcontractor_id;
    } else {
      externalId = `sub_${Date.now()}`;
    }
  }

  const record = {
    ...data,
    subcontractor_id: externalId,
    last_contact: now,
    qualification_status: data.qualification_status || QUALIFICATION_STATUSES.NEW_LEAD,
    recruitment_step: data.recruitment_step || RECRUITMENT_STEPS.OPENING,
    lead_source: data.lead_source || 'manual',
    contact_attempts: data.contact_attempts || 1,
    dnc_status: data.dnc_status || false,
    qualification_data: data.qualification_data || {}
  };

  if (record.primary_trade) {
    record.primary_trade = normalizeTrade(record.primary_trade) || record.primary_trade;
  }

  if (!data.qualification_status) {
    record.qualification_status = determineQualificationStatus(record);
  }

  const mapped = mapJSToCore(record);
  const { ok, data: resData, status, parseError } = await coreRequest('POST', '/api/v1/subcontractors/upsert', { body: mapped });

  if (!ok) {
    log.error('subcontractor-recruiter', 'Failed to upsert subcontractor', { status });
    throw new Error(`Core subcontractor upsert failed (${status}): ${resData?.error || parseError?.message || 'unknown error'}`);
  }

  const finalRecord = resData?.subcontractor ? mapCoreToJS(resData.subcontractor) : mapCoreToJS(resData) || record;
  await syncWithContacts(finalRecord);
  log.info('subcontractor-recruiter', `Upserted subcontractor lead: ${finalRecord.company_name || finalRecord.contact_name || finalRecord.subcontractor_id}`);
  return finalRecord;
}

async function updateSubcontractor(subcontractorId, updates) {
  if (!subcontractorId) return null;
  
  let numericId = updates.id;
  let existing = null;
  if (!numericId) {
    existing = await getSubcontractorById(subcontractorId);
    if (!existing) return null;
    numericId = existing.id;
    updates = { ...existing, ...updates, qualification_data: { ...(existing.qualification_data || {}), ...(updates.qualification_data || {}) } };
  }

  updates.last_contact = new Date().toISOString();
  if (updates.primary_trade) {
    updates.primary_trade = normalizeTrade(updates.primary_trade) || updates.primary_trade;
  }

  if (!updates.qualification_status) {
    updates.qualification_status = determineQualificationStatus(updates);
  }

  const mapped = mapJSToCore(updates);
  const { ok, status, data: resData, parseError } = await coreRequest('POST', `/api/v1/subcontractors/${numericId}/update`, { body: mapped });
  
  if (!ok) {
    log.error('subcontractor-recruiter', 'Failed to update subcontractor', { status });
    throw new Error(`Core subcontractor update failed (${status}): ${resData?.error || parseError?.message || 'unknown error'}`);
  }

  if (updates.qualification_status) {
    await coreRequest('POST', `/api/v1/subcontractors/${numericId}/qualification`, { 
      body: { qualification_status: updates.qualification_status, recruitment_step: updates.recruitment_step } 
    });
  }

  const updatedRecord = resData?.subcontractor ? mapCoreToJS(resData.subcontractor) : updates;
  await syncWithContacts(updatedRecord);
  return updatedRecord;
}

async function syncWithContacts(subcontractor) {
  try {
    const contactList = await contacts.loadContacts();
    let contact = null;

    if (subcontractor.contact_id) {
      contact = contactList.find(c => c.id === subcontractor.contact_id);
    }
    if (!contact && subcontractor.phone) {
      contact = await contacts.findContact(subcontractor.phone);
    }
    if (!contact && subcontractor.email) {
      contact = await contacts.findContact(subcontractor.email);
    }
    if (!contact && subcontractor.contact_name) {
      contact = await contacts.findContact(subcontractor.contact_name);
    }

    const updates = {
      type: 'subcontractor',
      business_name: subcontractor.company_name || subcontractor.legal_name,
      trade: subcontractor.primary_trade,
      trade_raw: subcontractor.primary_trade ? getTradeDisplayName(subcontractor.primary_trade) : null,
      licensed: subcontractor.license_status === 'LICENSE_VERIFIED' ? true : (subcontractor.license_required === false ? false : null),
      license_number: subcontractor.license_number,
      gl_insurance: subcontractor.general_liability,
      wc_insurance: subcontractor.workers_comp,
      crew_size: subcontractor.crew_size,
      weekly_capacity: subcontractor.availability,
      references: subcontractor.references || []
    };

    if (contact) {
      await contacts.updateContact(contact.id, updates);
      if (!subcontractor.contact_id) {
        subcontractor.contact_id = contact.id;
      }
    } else if (subcontractor.contact_name || subcontractor.phone || subcontractor.email) {
      const created = await contacts.createContact({
        name: subcontractor.contact_name,
        phones: subcontractor.phone ? [subcontractor.phone] : [],
        emails: subcontractor.email ? [subcontractor.email] : [],
        relationship: subcontractor.primary_trade ? `subcontractor (${getTradeDisplayName(subcontractor.primary_trade)})` : 'subcontractor',
        type: 'subcontractor',
        notes: `Recruited for Restoricon 2027 network. ID: ${subcontractor.subcontractor_id}`,
        source: subcontractor.lead_source || 'recruitment'
      });
      await contacts.updateContact(created.id, updates);
      subcontractor.contact_id = created.id;
    }
  } catch (err) {
    log.error('subcontractor-recruiter', 'Failed to sync with contacts', { error: err.message });
  }
}

function getMissingDocuments(subcontractor) {
  if (!subcontractor) return [];
  const missing = [];

  if (!subcontractor.w9_received) {
    missing.push('W-9 (Taxpayer Identification Form)');
  }
  if (!subcontractor.msa_signed) {
    missing.push('Signed Master Subcontractor Agreement (MSA)');
  }
  if (!subcontractor.coi_received) {
    missing.push('Certificate of Insurance (General Liability with Restoricon as Additional Insured)');
  }
  if (subcontractor.workers_comp === null || (!subcontractor.workers_comp && subcontractor.insurance_status === 'INSURANCE_REVIEW_REQUIRED')) {
    missing.push("Workers' Compensation Certificate or Applicable Exemption Verification");
  }
  if (subcontractor.license_required !== false && subcontractor.license_status !== 'LICENSE_VERIFIED' && subcontractor.license_status !== 'LICENSE_NOT_REQUIRED_FOR_REPORTED_SCOPE') {
    missing.push('State Trade License / HIC Registration Copy or Number');
  }
  if ((!subcontractor.references || subcontractor.references.length === 0) && !subcontractor.portfolio_url) {
    missing.push('Trade References / Project Portfolio');
  }

  return missing;
}

function determineQualificationStatus(subcontractor) {
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.APPROVED_ONBOARDING) {
    return QUALIFICATION_STATUSES.APPROVED_ONBOARDING;
  }
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.ONBOARDING_COMPLETE) {
    return QUALIFICATION_STATUSES.ONBOARDING_COMPLETE;
  }
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.DECLINED) {
    return QUALIFICATION_STATUSES.DECLINED;
  }
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.DO_NOT_CONTACT || subcontractor.dnc_status) {
    return QUALIFICATION_STATUSES.DO_NOT_CONTACT;
  }
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.FOLLOW_UP_REQUESTED) {
    return QUALIFICATION_STATUSES.FOLLOW_UP_REQUESTED;
  }

  if (subcontractor.w9_received && subcontractor.msa_signed && subcontractor.coi_received) {
    return QUALIFICATION_STATUSES.DOCUMENTS_UNDER_REVIEW;
  }
  if (subcontractor.msa_sent && !subcontractor.msa_signed) {
    return QUALIFICATION_STATUSES.MSA_PENDING;
  }
  if (subcontractor.w9_received || subcontractor.coi_received || subcontractor.msa_signed) {
    return QUALIFICATION_STATUSES.DOCUMENTS_PARTIALLY_RECEIVED;
  }
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.DOCUMENTS_REQUESTED) {
    return QUALIFICATION_STATUSES.DOCUMENTS_REQUESTED;
  }

  const hasBasicCompanyInfo = Boolean(subcontractor.company_name || subcontractor.legal_name || subcontractor.contact_name);
  const hasTrade = Boolean(subcontractor.primary_trade);
  const hasServiceArea = Boolean(subcontractor.service_area);
  const hasExperience = Boolean(subcontractor.years_in_business != null || subcontractor.qualification_data?.experience_years);
  const hasAvailability = Boolean(subcontractor.availability || subcontractor.qualification_data?.availability_2027 != null);
  const isInterested = subcontractor.qualification_data?.interested !== false;

  if (!isInterested) {
    return QUALIFICATION_STATUSES.DECLINED;
  }

  if (hasBasicCompanyInfo && hasTrade && hasServiceArea && hasExperience && hasAvailability) {
    return QUALIFICATION_STATUSES.QUALIFIED_PENDING_DOCUMENTS;
  }

  if (hasBasicCompanyInfo || hasTrade || subcontractor.recruitment_step !== RECRUITMENT_STEPS.OPENING) {
    return QUALIFICATION_STATUSES.QUALIFICATION_IN_PROGRESS;
  }

  if (subcontractor.contact_attempts > 0) {
    return QUALIFICATION_STATUSES.CONTACTED;
  }

  return QUALIFICATION_STATUSES.NEW_LEAD;
}

function determineNextRecruitmentStep(subcontractor) {
  if (!subcontractor) return RECRUITMENT_STEPS.OPENING;
  const q = subcontractor.qualification_data || {};

  if (q.permission_granted === false || q.interested === false) {
    return RECRUITMENT_STEPS.QUALIFIED_REVIEW;
  }
  if (!q.permission_granted && !subcontractor.company_name && !subcontractor.primary_trade) {
    return RECRUITMENT_STEPS.OPENING;
  }
  if (!subcontractor.company_name && !subcontractor.legal_name && !subcontractor.contact_name) {
    return RECRUITMENT_STEPS.COMPANY_INFO;
  }
  if (!subcontractor.primary_trade) {
    return RECRUITMENT_STEPS.TRADE_QUALIFICATION;
  }
  if (!q.trade_specific_answered) {
    return RECRUITMENT_STEPS.TRADE_SPECIFIC;
  }
  if (subcontractor.years_in_business == null && !q.experience_years) {
    return RECRUITMENT_STEPS.EXPERIENCE;
  }
  if (!subcontractor.service_area && !q.service_area_answered) {
    return RECRUITMENT_STEPS.SERVICE_AREA;
  }
  if (!subcontractor.availability && q.availability_2027 == null) {
    return RECRUITMENT_STEPS.AVAILABILITY;
  }
  if (subcontractor.license_status == null && subcontractor.license_required == null && q.license_answered == null) {
    return RECRUITMENT_STEPS.LICENSING;
  }
  if (subcontractor.general_liability == null && q.insurance_answered == null) {
    return RECRUITMENT_STEPS.INSURANCE;
  }
  if (q.willing_to_onboard_msa == null) {
    return RECRUITMENT_STEPS.ONBOARDING_MSA;
  }

  return RECRUITMENT_STEPS.DOCUMENTS_REQUEST;
}

function buildRecruiterSystemPrompt(subcontractor, channel = 'sms', agentName = 'Aigentik', ownerName = 'the Restoricon management team') {
  const tradeSlug = subcontractor?.primary_trade ? normalizeTrade(subcontractor.primary_trade) || subcontractor.primary_trade : null;
  const tradeDisplay = tradeSlug ? getTradeDisplayName(tradeSlug) : 'residential construction';
  const tradeQuestions = tradeSlug ? getTradeSpecificQuestions(tradeSlug).slice(0, 2).join(' ') : '';
  const missingDocs = getMissingDocuments(subcontractor);
  const step = determineNextRecruitmentStep(subcontractor);

  return [
    `You are ${agentName}, a professional business-development representative for Restoricon, LLC.`,
    `Restoricon is a Connecticut-based residential remodeling, restoration, repair, and general contracting company.`,
    `We are currently in a slow-launch phase and are building our network of qualified subcontractors, suppliers, and industry partners ahead of our planned January 2027 operational ramp-up.`,
    `Primary Message: Restoricon wants to establish long-term relationships with reliable subcontractors and provide opportunities for additional project work as the company's project pipeline grows.`,
    `\nCRITICAL RESTORICON POSITIONING & LANGUAGE RULES:`,
    `- MANDATORY PHRASING: Always say "We're currently building our subcontractor network ahead of our planned January 2027 ramp-up."`,
    `- PROHIBITED PHRASES (NEVER SAY):`,
    `  * "We have hundreds of jobs waiting."`,
    `  * "We guarantee you'll get work."`,
    `  * "You are approved." (NEVER approve a contractor independently)`,
    `  * "You'll definitely receive projects."`,
    `- NEVER guarantee work, project volume, revenue, or specific income.`,
    `- NEVER invent pricing or pay rates. State that project pricing and compensation are determined based on the specific scope of work and agreement with Restoricon.`,
    `- NEVER give legal or insurance advice. Note license and insurance details for verification by Restoricon.`,
    `- Do NOT promise projects in any specific town. Restoricon is focused on CT residential projects, with emphasis on Hartford County and surrounding areas.`,
    `- Be conversational, courteous, and professional. Do NOT read questions mechanically like a robotic questionnaire.`,
    channel === 'sms' ? `- Keep responses concise for SMS (1 to 3 short sentences plus the question).` : `- Format as a clean, professional email.`,
    `\nCANDIDATE CONTEXT:`,
    `- Candidate / Business: ${subcontractor?.company_name || subcontractor?.contact_name || 'Prospect'}`,
    `- Trade: ${tradeDisplay}`,
    `- Current Step: ${step}`,
    `- Qualification Status: ${subcontractor?.qualification_status || 'NEW_LEAD'}`,
    tradeQuestions ? `- Relevant trade focus questions: ${tradeQuestions}` : '',
    missingDocs.length > 0 ? `- Missing Onboarding Documents: ${missingDocs.join(', ')}` : '',
    `\nCONVERSATIONAL GOAL:`,
    `Acknowledge what the candidate just said naturally, answer any questions using Restoricon facts, handle any objections politely, and guide the candidate through the next qualification step (${step}).`,
    `Do NOT ask every single question at once. Ask at most 1 or 2 natural questions at a time.`
  ].filter(Boolean).join('\n');
}

function formatSubcontractorSummary(s) {
  if (!s) return 'Subcontractor not found.';
  const trade = s.primary_trade ? getTradeDisplayName(s.primary_trade) : 'Not specified';
  const missing = getMissingDocuments(s);

  return [
    `🛠️ Subcontractor Profile: ${s.company_name || s.contact_name || 'Unnamed'} (${s.subcontractor_id})`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `👤 Contact: ${s.contact_name || 'N/A'}${s.title ? ' (' + s.title + ')' : ''}`,
    `🏢 Legal Name: ${s.legal_name || 'N/A'}${s.dba ? ' | DBA: ' + s.dba : ''}`,
    `📞 Phone: ${s.phone || 'N/A'} | ✉️ Email: ${s.email || 'N/A'}`,
    `🌐 Website: ${s.website || 'N/A'}`,
    `🔨 Primary Trade: ${trade}`,
    s.secondary_trades?.length ? `🪚 Secondary Trades: ${s.secondary_trades.map(t => getTradeDisplayName(t)).join(', ')}` : null,
    `📍 Service Area: ${s.service_area || 'Connecticut (Hartford County & surrounding)'}`,
    `👷 Crew Size: ${s.crew_size != null ? s.crew_size : 'N/A'} | Experience: ${s.years_in_business != null ? s.years_in_business + ' yrs' : 'N/A'}`,
    `🗓️ Availability: ${s.availability || 'Building network for Jan 2027 ramp-up'}`,
    `📄 License: ${s.license_number ? '#' + s.license_number + ' (' + (s.license_status || 'PENDING_VERIFICATION') + ')' : (s.license_required === false ? 'Not required for reported scope' : 'Unverified')}`,
    `🛡️ Insurance: GL: ${s.general_liability ? 'Yes' : (s.general_liability === false ? 'None/Review Required' : 'Pending')} | WC: ${s.workers_comp ? 'Yes' : (s.workers_comp === false ? 'None/Review Required' : 'Pending')} | COI: ${s.coi_received ? 'Received' : 'Pending'}`,
    `📑 Onboarding: MSA: ${s.msa_signed ? 'Signed' : (s.msa_sent ? 'Sent' : 'Pending')} | W-9: ${s.w9_received ? 'Received' : 'Pending'}`,
    `📊 Status: [${s.qualification_status || 'NEW_LEAD'}]`,
    missing.length > 0 ? `⚠️ Missing Docs:\n  - ${missing.join('\n  - ')}` : `✅ All core documents on file.`,
    s.notes ? `📝 Notes: ${s.notes}` : null
  ].filter(Boolean).join('\n');
}

async function formatPipelineReport(subcontractors) {
  const list = subcontractors || await loadSubcontractors();
  if (!list.length) return 'No subcontractors currently in the recruitment pipeline.';

  const counts = {};
  for (const status of Object.values(QUALIFICATION_STATUSES)) {
    counts[status] = 0;
  }
  for (const s of list) {
    const st = s.qualification_status || QUALIFICATION_STATUSES.NEW_LEAD;
    counts[st] = (counts[st] || 0) + 1;
  }

  const lines = [
    `📋 Restoricon Subcontractor Pipeline Report`,
    `Total Subcontractors: ${list.length}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `• New Leads: ${counts[QUALIFICATION_STATUSES.NEW_LEAD] || 0}`,
    `• In Qualification: ${(counts[QUALIFICATION_STATUSES.CONTACTED] || 0) + (counts[QUALIFICATION_STATUSES.CONVERSATION_STARTED] || 0) + (counts[QUALIFICATION_STATUSES.INTERESTED] || 0) + (counts[QUALIFICATION_STATUSES.QUALIFICATION_IN_PROGRESS] || 0)}`,
    `• Qualified (Pending Documents): ${counts[QUALIFICATION_STATUSES.QUALIFIED_PENDING_DOCUMENTS] || 0}`,
    `• Documents In Progress: ${(counts[QUALIFICATION_STATUSES.DOCUMENTS_REQUESTED] || 0) + (counts[QUALIFICATION_STATUSES.DOCUMENTS_PARTIALLY_RECEIVED] || 0) + (counts[QUALIFICATION_STATUSES.MSA_PENDING] || 0) + (counts[QUALIFICATION_STATUSES.INSURANCE_PENDING] || 0) + (counts[QUALIFICATION_STATUSES.LICENSE_PENDING] || 0)}`,
    `• Documents Under Review: ${counts[QUALIFICATION_STATUSES.DOCUMENTS_UNDER_REVIEW] || 0}`,
    `• Approved / Onboarded: ${(counts[QUALIFICATION_STATUSES.APPROVED_ONBOARDING] || 0) + (counts[QUALIFICATION_STATUSES.ONBOARDING_COMPLETE] || 0)}`,
    `• Declined / DNC: ${(counts[QUALIFICATION_STATUSES.DECLINED] || 0) + (counts[QUALIFICATION_STATUSES.DO_NOT_CONTACT] || 0)}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  ];

  const active = list.filter(s => s.qualification_status !== QUALIFICATION_STATUSES.DECLINED && s.qualification_status !== QUALIFICATION_STATUSES.DO_NOT_CONTACT).slice(0, 10);
  if (active.length) {
    lines.push('\nRecent Active Candidates:');
    for (const s of active) {
      const trade = s.primary_trade ? getTradeDisplayName(s.primary_trade) : 'Trade TBD';
      lines.push(`• [${s.subcontractor_id}] ${s.company_name || s.contact_name || 'Lead'} — ${trade} [${s.qualification_status}]`);
    }
  }

  return lines.join('\n');
}

async function formatFollowupList(subcontractors) {
  const list = subcontractors || await loadSubcontractors();
  const followups = list.filter(s =>
    s.qualification_status === QUALIFICATION_STATUSES.FOLLOW_UP_REQUESTED ||
    s.qualification_status === QUALIFICATION_STATUSES.CONTACTED ||
    s.qualification_status === QUALIFICATION_STATUSES.DOCUMENTS_REQUESTED ||
    s.qualification_status === QUALIFICATION_STATUSES.QUALIFIED_PENDING_DOCUMENTS
  );

  if (!followups.length) return 'No pending subcontractor follow-ups.';

  const lines = ['🔔 Subcontractors Pending Follow-up:\n'];
  for (const s of followups) {
    lines.push(`• [${s.subcontractor_id}] ${s.company_name || s.contact_name || s.phone || s.email} — Trade: ${s.primary_trade ? getTradeDisplayName(s.primary_trade) : 'TBD'} (Status: ${s.qualification_status}, Last: ${s.last_contact ? s.last_contact.substring(0, 10) : 'Never'})`);
  }
  return lines.join('\n');
}

export {
  QUALIFICATION_STATUSES,
  RECRUITMENT_STEPS,
  RECRUITER_FAQS,
  RECRUITER_OBJECTIONS,
  OPENING_SCRIPT,
  FOLLOW_UP_TEMPLATES,
  mapCoreToJS,
  mapJSToCore,
  loadSubcontractors,
  saveSubcontractors,
  generateSubcontractorId,
  getSubcontractorById,
  findSubcontractor,
  createOrUpdateSubcontractorLead,
  updateSubcontractor,
  getMissingDocuments,
  determineQualificationStatus,
  determineNextRecruitmentStep,
  buildRecruiterSystemPrompt,
  formatSubcontractorSummary,
  formatPipelineReport,
  formatFollowupList
};
