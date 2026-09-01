// tests/customer-module.test.js — Unit tests for Restoricon Customer Intake,
// Sales & Support Module.
// Cut over to Restoricon Core write-through calls (B2 task 4, CODEY_MASTER_PLAN.md §6.4).

import { jest } from '@jest/globals';
import {
  RESTORICON_INFO,
  CUSTOMER_CATEGORIES,
  PROJECT_CATEGORIES,
  PROJECT_SUBTYPES,
  PROPERTY_TYPES,
  LEAD_STATUSES,
  LEAD_SCORES,
  SUPPORT_CATEGORIES,
  INITIAL_GREETING,
  APPROVED_FAQS,
  APPROVED_OBJECTIONS,
  QUALIFICATION_QUESTIONS,
  checkEmergencyKeywords,
  checkEscalationKeywords,
  calculateLeadScore,
  formatHandoffSummary,
  buildCustomerSystemPrompt,
  formatCustomerSummary,
  formatCustomerPipelineReport,
  formatCustomerFollowupList,
  createOrUpdateCustomer,
  getCustomerById,
  findCustomer,
  updateCustomer,
  loadCustomers,
  mapCoreToJS,
  mapJSToCore
} from '../customer-module.js';

describe('Restoricon Customer Module — Positioning & Knowledge Base', () => {
  it('contains approved Restoricon company description and 2027 slow-launch context', () => {
    expect(RESTORICON_INFO.company_name).toBe('Restoricon, LLC');
    expect(RESTORICON_INFO.service_area).toContain('Hartford County');
    expect(RESTORICON_INFO.launch_phase).toContain('January 2027');
    expect(RESTORICON_INFO.core_principle).toContain('understand the customer’s problem');
  });

  it('includes natural initial greeting', () => {
    expect(INITIAL_GREETING).toContain('Thank you for contacting Restoricon');
    expect(INITIAL_GREETING).toContain('What type of work are you looking to have done?');
  });

  it('provides approved FAQ answers for key customer inquiries', () => {
    const serviceArea = APPROVED_FAQS.find(f => f.topic === 'service_area');
    expect(serviceArea.answer).toContain('Connecticut');
    expect(serviceArea.answer).toContain('Hartford County');

    const pricing = APPROVED_FAQS.find(f => f.topic === 'pricing_general');
    expect(pricing.answer.toLowerCase()).toContain('depends on the scope');

    const permits = APPROVED_FAQS.find(f => f.topic === 'permits');
    expect(permits.answer.toLowerCase()).toContain('permit requirements depend on the specific work');

    const whyChoose = APPROVED_FAQS.find(f => f.topic === 'why_choose_restoricon');
    expect(whyChoose.answer).toContain('professional project coordination');
  });

  it('provides approved objection handling', () => {
    expect(APPROVED_OBJECTIONS.multiple_estimates).toContain('completely understandable');
    expect(APPROVED_OBJECTIONS.price_too_high).toContain('review the scope');
    expect(APPROVED_OBJECTIONS.not_ready_yet).toContain('When are you thinking about starting');
  });

  it('contains specialized qualification questions by project category', () => {
    expect(QUALIFICATION_QUESTIONS.remodeling.kitchen.length).toBeGreaterThan(0);
    expect(QUALIFICATION_QUESTIONS.exterior.roofing.length).toBeGreaterThan(0);
    expect(QUALIFICATION_QUESTIONS.restoration.water_damage.length).toBeGreaterThan(0);
    expect(QUALIFICATION_QUESTIONS.restoration.mold_related.length).toBeGreaterThan(0);
  });
});

describe('Emergency & Escalation Keyword Detection', () => {
  it('detects urgent active emergencies', () => {
    expect(checkEmergencyKeywords('Water is gushing from a burst pipe in the basement!')).toBe(true);
    expect(checkEmergencyKeywords('Major flooding in living room')).toBe(true);
    expect(checkEmergencyKeywords('We smell gas and see smoke in the kitchen')).toBe(true);
    expect(checkEmergencyKeywords('Part of the ceiling is collapsing')).toBe(true);
  });

  it('does not false-positive on standard project inquiries', () => {
    expect(checkEmergencyKeywords('I would like an estimate for painting our dining room')).toBe(false);
    expect(checkEmergencyKeywords('Can someone look at replacing our vinyl siding next month?')).toBe(false);
  });

  it('detects escalation triggers (legal, BBB, human request, dispute)', () => {
    expect(checkEscalationKeywords('I want to speak with your lawyer about this lawsuit')).toBe(true);
    expect(checkEscalationKeywords('I am filing a complaint with the BBB and consumer protection')).toBe(true);
    expect(checkEscalationKeywords('Let me talk to a real person / human immediately')).toBe(true);
    expect(checkEscalationKeywords('I want to speak to the owner right now')).toBe(true);
  });

  it('does not trigger escalation for ordinary inquiries', () => {
    expect(checkEscalationKeywords('What is the typical timeframe for a bathroom remodel?')).toBe(false);
  });

  it('matches keywords on word boundaries, not as substrings of unrelated tokens', () => {
    // "manager" inside an email address must not read as an escalation
    expect(checkEscalationKeywords('my email is cadre.projectmanager@gmail.com and I am home Friday')).toBe(false);
    // but a real request for a manager still does
    expect(checkEscalationKeywords('please connect me with a manager')).toBe(true);
    // "fire" inside "firefighters"/"fireplace" is not an active-fire emergency
    expect(checkEmergencyKeywords('we are redoing the fireplace surround')).toBe(false);
    expect(checkEmergencyKeywords('there is a fire in the kitchen right now')).toBe(true);
  });
});

describe('Lead Scoring Intelligence', () => {
  it('scores highly qualified, local, ready homeowners as HOT', () => {
    const hotLead = {
      customer_name: 'John Smith',
      phone: '860-555-1234',
      email: 'john@example.com',
      city: 'West Hartford',
      state: 'CT',
      owner_status: true,
      project_type: 'kitchen_remodeling',
      project_description: 'Full kitchen remodel with new cabinets and island',
      project_urgency: 'High',
      lead_status: LEAD_STATUSES.APPOINTMENT_REQUESTED
    };

    const score = calculateLeadScore(hotLead);
    expect(score).toBe(LEAD_SCORES.HOT);
  });

  it('scores exploratory inquiries as WARM or COLD', () => {
    const warmLead = {
      customer_name: 'Jane Doe',
      phone: '860-555-5678',
      city: 'Hartford',
      state: 'CT',
      owner_status: true,
      project_type: 'bathroom_remodeling',
      project_urgency: 'Standard'
    };

    const score = calculateLeadScore(warmLead);
    expect(score).toBe(LEAD_SCORES.WARM);

    const coldLead = {
      customer_name: 'Unknown Caller'
    };
    expect(calculateLeadScore(coldLead)).toBe(LEAD_SCORES.COLD);
  });

  it('scores DNC or out-of-service-area as UNQUALIFIED', () => {
    expect(calculateLeadScore({ dnc_status: true })).toBe(LEAD_SCORES.UNQUALIFIED);
    expect(calculateLeadScore({ lead_status: LEAD_STATUSES.OUT_OF_SERVICE_AREA })).toBe(LEAD_SCORES.UNQUALIFIED);
  });
});

describe('Human Handoff & Prompt Generation', () => {
  it('formats comprehensive human handoff summary', () => {
    const customer = {
      customer_name: 'Michael Scott',
      phone: '860-555-0199',
      email: 'mscott@example.com',
      property_address: '1725 Slough Ave',
      city: 'Scranton',
      state: 'CT',
      project_category: 'remodeling',
      project_type: 'office_renovation',
      photos_received: ['photo1.jpg', 'photo2.jpg'],
      appointment_date: '2026-09-01',
      appointment_time: '10:00 AM'
    };

    const handoff = formatHandoffSummary({
      customer,
      issue: 'Customer requested direct quote discount review',
      urgency: 'Medium',
      whatCustomerWants: 'Owner review on project pricing',
      nextAction: 'Call customer to discuss scope options'
    });

    expect(handoff).toContain('RESTORICON HUMAN HANDOFF REQUIRED');
    expect(handoff).toContain('Michael Scott');
    expect(handoff).toContain('1725 Slough Ave');
    expect(handoff).toContain('Customer requested direct quote discount review');
    expect(handoff).toContain('2 photo(s)');
  });

  it('builds customer system prompt enforcing safety guardrails and 2027 context', () => {
    const prompt = buildCustomerSystemPrompt({
      customer: {
        customer_name: 'Sarah Connor',
        project_type: 'basement_finishing',
        lead_status: 'QUALIFIED'
      },
      channel: 'sms'
    });

    expect(prompt).toContain('Restoricon, LLC');
    expect(prompt).toContain('January 2027');
    expect(prompt).toContain('NEVER INVENT PRICING');
    expect(prompt).toContain('NEVER DIAGNOSE REMOTELY');
    expect(prompt).toContain('NEVER GUARANTEE INSURANCE CLAIM APPROVAL');
    expect(prompt).toContain('NEVER DECLARE A STRUCTURE SAFE');
    expect(prompt).toContain('Sarah Connor');
  });
});

describe('Mapping: mapCoreToJS & mapJSToCore (~46 fields)', () => {
  it('correctly round-trips rich customer attributes between Core and JS', () => {
    const jsOriginal = {
      id: 42,
      customer_id: 'CUST-TEST-42',
      customer_name: 'Jane Doe',
      preferred_name: 'Janie',
      phone: '860-555-1234',
      email: 'jane@example.com',
      property_address: '123 Main St',
      city: 'Hartford',
      state: 'CT',
      zip: '06103',
      property_type: 'Single-family',
      owner_status: true,
      occupancy_status: 'Occupied',
      customer_category: 'NEW_CUSTOMER',
      project_category: 'remodeling',
      project_type: 'kitchen_remodeling',
      project_description: 'Full remodel',
      customer_goal: 'Modernize kitchen',
      rooms_affected: ['kitchen', 'dining'],
      approximate_size: '300 sq ft',
      materials_requested: 'Quartz countertops',
      design_needed: true,
      project_urgency: 'High',
      desired_start_date: '2026-10-01',
      desired_completion_date: '2026-12-01',
      customer_budget: '$45,000',
      insurance_related: false,
      insurance_company: null,
      claim_number: null,
      adjuster: null,
      incident_date: null,
      photos_received: ['k1.jpg'],
      documents_received: ['floorplan.pdf'],
      lead_source: 'website',
      lead_status: 'QUALIFIED',
      lead_score: 'HOT',
      appointment_date: '2026-09-15',
      appointment_time: '10:00 AM',
      appointment_status: 'CONFIRMED',
      last_contact: '2026-08-28T00:00:00Z',
      next_followup: '2026-09-01T00:00:00Z',
      contact_preference: 'sms',
      best_contact_time: 'mornings',
      customer_notes: ['First consultation complete'],
      dnc_status: false,
      escalation_status: null,
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-28T00:00:00Z'
    };

    const coreMapped = mapJSToCore(jsOriginal);
    expect(coreMapped.first_name).toBe('Jane');
    expect(coreMapped.last_name).toBe('Doe');
    expect(coreMapped.external_id).toBe('CUST-TEST-42');
    expect(coreMapped.custom_fields.customer_budget).toBe('$45,000');
    expect(coreMapped.custom_fields.rooms_affected).toEqual(['kitchen', 'dining']);

    const jsRestored = mapCoreToJS(coreMapped);
    expect(jsRestored.customer_id).toBe(jsOriginal.customer_id);
    expect(jsRestored.customer_name).toBe(jsOriginal.customer_name);
    expect(jsRestored.preferred_name).toBe(jsOriginal.preferred_name);
    expect(jsRestored.phone).toBe(jsOriginal.phone);
    expect(jsRestored.email).toBe(jsOriginal.email);
    expect(jsRestored.property_address).toBe(jsOriginal.property_address);
    expect(jsRestored.city).toBe(jsOriginal.city);
    expect(jsRestored.customer_budget).toBe(jsOriginal.customer_budget);
    expect(jsRestored.rooms_affected).toEqual(jsOriginal.rooms_affected);
    expect(jsRestored.appointment_date).toBe(jsOriginal.appointment_date);
    expect(jsRestored.customer_notes).toEqual(jsOriginal.customer_notes);
  });
});

describe('CRM State & Reporting Operations (Core write-through)', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  }

  it('loadCustomers fetches all customers from Core API', async () => {
    const coreList = [
      {
        id: 1,
        external_id: 'CUST-001',
        first_name: 'Alice',
        last_name: 'Johnson',
        phone: '8602223344',
        email: 'alice@test.com',
        custom_fields: { customer_name: 'Alice Johnson', lead_score: 'HOT', lead_status: 'NEW' }
      },
      {
        id: 2,
        external_id: 'CUST-002',
        first_name: 'Bob',
        last_name: 'Smith',
        phone: '8605554321',
        email: 'bob@test.com',
        custom_fields: { customer_name: 'Bob Smith', lead_score: 'WARM', lead_status: 'QUALIFIED' }
      }
    ];

    fetchSpy.mockResolvedValue(mockResponse(200, { customers: coreList }));

    const customers = await loadCustomers();
    expect(customers).toHaveLength(2);
    expect(customers[0].customer_id).toBe('CUST-001');
    expect(customers[0].customer_name).toBe('Alice Johnson');
    expect(customers[1].customer_id).toBe('CUST-002');
    expect(customers[1].customer_name).toBe('Bob Smith');

    const [url, options] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/v1/customers');
    expect(options.method).toBe('GET');
    expect(options.headers.Authorization).toMatch(/^Bearer /);
  });

  it('findCustomer queries Core search endpoint and returns mapped customer', async () => {
    const coreCustomer = {
      id: 1,
      external_id: 'CUST-001',
      first_name: 'Alice',
      last_name: 'Johnson',
      phone: '8602223344',
      email: 'alice@test.com',
      custom_fields: { customer_name: 'Alice Johnson' }
    };

    fetchSpy.mockResolvedValue(mockResponse(200, { customer: coreCustomer }));

    const found = await findCustomer('alice@test.com');
    expect(found).toBeDefined();
    expect(found.customer_id).toBe('CUST-001');
    expect(found.customer_name).toBe('Alice Johnson');

    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/v1/customers/search?q=alice%40test.com');
  });

  it('getCustomerById queries by numeric ID or delegates to search', async () => {
    const coreCustomer = {
      id: 10,
      external_id: 'CUST-010',
      first_name: 'David',
      last_name: 'Clark',
      custom_fields: { customer_name: 'David Clark' }
    };

    fetchSpy.mockResolvedValue(mockResponse(200, { customer: coreCustomer }));

    const found = await getCustomerById(10);
    expect(found.customer_id).toBe('CUST-010');
    expect(found.customer_name).toBe('David Clark');

    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/v1/customers/10');
  });

  it('createOrUpdateCustomer upserts via Core API when customer_id is provided', async () => {
    const createdCore = {
      id: 5,
      external_id: 'CUST-NEW-001',
      first_name: 'Alice',
      last_name: 'Johnson',
      phone: '8602223344',
      email: 'alice@restoricon-test.com',
      service_address: '100 Main St',
      custom_fields: {
        customer_name: 'Alice Johnson',
        property_address: '100 Main St',
        city: 'Hartford',
        state: 'CT',
        project_category: 'remodeling',
        project_type: 'kitchen_remodeling'
      }
    };

    fetchSpy.mockResolvedValue(mockResponse(200, { customer: createdCore }));

    const newCust = await createOrUpdateCustomer({
      customer_id: 'CUST-NEW-001',
      customer_name: 'Alice Johnson',
      phone: '8602223344',
      email: 'alice@restoricon-test.com',
      property_address: '100 Main St',
      city: 'Hartford',
      state: 'CT',
      project_category: PROJECT_CATEGORIES.REMODELING,
      project_type: PROJECT_SUBTYPES.KITCHEN,
      owner_status: true
    });

    expect(newCust).toBeDefined();
    expect(newCust.customer_id).toBe('CUST-NEW-001');
    expect(newCust.customer_name).toBe('Alice Johnson');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/v1/customers/upsert');
    expect(options.method).toBe('POST');
  });

  it('createOrUpdateCustomer searches before upsert when customer_id is omitted', async () => {
    const foundCore = {
      id: 5,
      external_id: 'CUST-EXISTING-99',
      first_name: 'Alice',
      last_name: 'Johnson',
      phone: '8602223344',
      email: 'alice@restoricon-test.com',
      custom_fields: {
        customer_name: 'Alice Johnson'
      }
    };

    const updatedCore = {
      ...foundCore,
      custom_fields: {
        ...foundCore.custom_fields,
        project_description: 'Updated scope'
      }
    };

    // First search lookup
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { customer: foundCore }));
    // Upsert call
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { customer: updatedCore }));

    const res = await createOrUpdateCustomer({
      phone: '8602223344',
      project_description: 'Updated scope'
    });

    expect(res).toBeDefined();
    expect(res.customer_id).toBe('CUST-EXISTING-99');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('updateCustomer updates via Core API numeric ID or upsert', async () => {
    const existingCore = {
      id: 5,
      external_id: 'CUST-NEW-001',
      first_name: 'Alice',
      last_name: 'Johnson',
      custom_fields: { customer_name: 'Alice Johnson' }
    };

    const updatedCore = {
      id: 5,
      external_id: 'CUST-NEW-001',
      first_name: 'Alice',
      last_name: 'Johnson',
      status: 'active',
      custom_fields: {
        customer_name: 'Alice Johnson',
        lead_status: 'APPOINTMENT_SCHEDULED',
        appointment_date: '2026-09-05'
      }
    };

    // getCustomerById lookup
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { customer: existingCore }));
    // update endpoint
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { customer: updatedCore }));

    const updated = await updateCustomer('CUST-NEW-001', {
      lead_status: LEAD_STATUSES.APPOINTMENT_SCHEDULED,
      appointment_date: '2026-09-05'
    });

    expect(updated.lead_status).toBe(LEAD_STATUSES.APPOINTMENT_SCHEDULED);
    expect(updated.appointment_date).toBe('2026-09-05');

    const [url, options] = fetchSpy.mock.calls[1];
    expect(String(url)).toContain('/api/v1/customers/upsert');
    expect(options.method).toBe('POST');
  });

  it('formats customer profile summary', () => {
    const customer = {
      customer_id: 'CUST-TEST-1234',
      customer_name: 'Bob Miller',
      phone: '860-555-4321',
      email: 'bob@example.com',
      property_address: '45 Elm Street',
      city: 'Glastonbury',
      state: 'CT',
      lead_score: LEAD_SCORES.HOT,
      lead_status: LEAD_STATUSES.QUALIFIED,
      project_category: 'Remodeling',
      project_type: 'Bathroom',
      project_description: 'Master bathroom walk-in shower and double vanity',
      insurance_related: false
    };

    const summary = formatCustomerSummary(customer);
    expect(summary).toContain('Bob Miller');
    expect(summary).toContain('CUST-TEST-1234');
    expect(summary).toContain('Bathroom');
    expect(summary).toContain('HOT');
  });

  it('formats customer pipeline report and followup list from Core API data', async () => {
    const mockList = [
      {
        id: 1,
        external_id: 'CUST-001',
        first_name: 'Alice',
        last_name: 'Johnson',
        custom_fields: {
          customer_name: 'Alice Johnson',
          lead_status: 'NEW',
          lead_score: 'HOT',
          next_followup: '2026-09-01'
        }
      },
      {
        id: 2,
        external_id: 'CUST-002',
        first_name: 'Bob',
        last_name: 'Smith',
        custom_fields: {
          customer_name: 'Bob Smith',
          lead_status: 'FOLLOW_UP',
          lead_score: 'WARM'
        }
      }
    ];

    fetchSpy.mockResolvedValue(mockResponse(200, { customers: mockList }));

    const report = await formatCustomerPipelineReport();
    expect(typeof report).toBe('string');
    expect(report).toContain('Restoricon Customer Pipeline Report (2 Total)');
    expect(report).toContain('HOT: 1');
    expect(report).toContain('WARM: 1');

    const followups = await formatCustomerFollowupList();
    expect(typeof followups).toBe('string');
    expect(followups).toContain('Restoricon Customer Follow-Up Queue (2)');
    expect(followups).toContain('Alice Johnson');
    expect(followups).toContain('Bob Smith');
  });
});
