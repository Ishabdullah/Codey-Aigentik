// tests/contacts.test.js — Unit tests for Aigentik contacts directory
// (Track B Phase B2 cutover: Restoricon Core API write-through)

import { jest } from '@jest/globals';
import * as contacts from '../contacts.js';

describe('contacts (Restoricon Core write-through)', () => {
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

  describe('Pure helper functions (no I/O)', () => {
    it('normalizePhone cleans formatted numbers to 10 digits', () => {
      expect(contacts.normalizePhone('(860) 555-1234')).toBe('8605551234');
      expect(contacts.normalizePhone('+1-860-555-1234')).toBe('8605551234');
      expect(contacts.normalizePhone(null)).toBeNull();
    });

    it('normalizeEmail converts to lowercase and trims whitespace', () => {
      expect(contacts.normalizeEmail('  TEST@Example.Com ')).toBe('test@example.com');
      expect(contacts.normalizeEmail(null)).toBeNull();
    });

    it('getMissingFields identifies missing contact fields', () => {
      const contact = {
        name: 'Alice',
        phones: ['860-555-1111'],
        emails: [],
        address: null
      };
      const missing = contacts.getMissingFields(contact, ['name', 'phone', 'email', 'address']);
      expect(missing).toEqual(['email', 'address']);
    });

    it('formatContact formats summary string', () => {
      const contact = {
        name: 'Bob Builder',
        relationship: 'contractor',
        phones: ['860-555-2222'],
        emails: ['bob@builder.com'],
        type: 'subcontractor',
        trade_raw: 'Roofing'
      };
      const formatted = contacts.formatContact(contact);
      expect(formatted).toContain('Bob Builder');
      expect(formatted).toContain('(contractor)');
      expect(formatted).toContain('📱 860-555-2222');
      expect(formatted).toContain('[subcontractor: Roofing]');
    });

    it('formatContactInfo formats multi-line contact details', () => {
      const contact = {
        name: 'Charlie Brown',
        relationship: 'client',
        phones: ['860-555-3333'],
        emails: ['charlie@peanuts.com'],
        address: '100 Main St',
        notes: 'VIP customer'
      };
      const info = contacts.formatContactInfo(contact);
      expect(info).toContain('👤 Charlie Brown');
      expect(info).toContain('🔗 client');
      expect(info).toContain('📱 860-555-3333');
      expect(info).toContain('✉️ charlie@peanuts.com');
      expect(info).toContain('🏠 100 Main St');
      expect(info).toContain('📝 VIP customer');
    });

    it('mapCoreToJS and mapJSToCore convert models correctly', () => {
      const core = {
        id: 5,
        external_id: 'contact_0005',
        name: 'Dave',
        licensed: 1,
        gl_insurance: 0,
        wc_insurance: null,
        phones: ['8605554444']
      };
      const js = contacts.mapCoreToJS(core);
      expect(js.id).toBe('contact_0005');
      expect(js._core_id).toBe(5);
      expect(js.licensed).toBe(true);
      expect(js.gl_insurance).toBe(false);
      expect(js.wc_insurance).toBeNull();

      const backToCore = contacts.mapJSToCore(js);
      expect(backToCore.external_id).toBe('contact_0005');
      expect(backToCore.licensed).toBe(1);
      expect(backToCore.gl_insurance).toBe(0);
      expect(backToCore.wc_insurance).toBeNull();
    });
  });

  describe('findContact', () => {
    it('returns null on empty identifier without calling fetch', async () => {
      expect(await contacts.findContact('')).toBeNull();
      expect(await contacts.findContact(null)).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('calls GET /api/v1/contacts/find?q=... and returns mapped contact', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        contact: {
          id: 1,
          external_id: 'contact_0001',
          name: 'Jane Doe',
          phones: ['8605559999']
        }
      }));

      const res = await contacts.findContact('8605559999');
      expect(res).not.toBeNull();
      expect(res.id).toBe('contact_0001');
      expect(res.name).toBe('Jane Doe');
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          href: expect.stringContaining('/api/v1/contacts/find?q=8605559999')
        }),
        expect.any(Object)
      );
    });

    it('returns null on 404', async () => {
      fetchSpy.mockResolvedValue(mockResponse(404, { error: 'Contact not found' }));
      const res = await contacts.findContact('nonexistent');
      expect(res).toBeNull();
    });
  });

  describe('getContactById', () => {
    it('calls GET /api/v1/contacts/:id and returns mapped contact', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        contact: {
          id: 2,
          external_id: 'contact_0002',
          name: 'Bob',
          phones: []
        }
      }));

      const res = await contacts.getContactById('contact_0002');
      expect(res).not.toBeNull();
      expect(res.id).toBe('contact_0002');
      expect(res.name).toBe('Bob');
    });
  });

  describe('createContact and updateContact', () => {
    it('createContact calls POST /api/v1/contacts with mapped payload', async () => {
      fetchSpy.mockResolvedValue(mockResponse(201, {
        contact: {
          id: 10,
          external_id: 'contact_0010',
          name: 'New Person',
          phones: ['8601112222'],
          emails: ['new@person.com'],
          type: 'person'
        }
      }));

      const created = await contacts.createContact({
        name: 'New Person',
        phones: '8601112222',
        emails: 'new@person.com'
      });

      expect(created.id).toBe('contact_0010');
      expect(created.name).toBe('New Person');
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          href: expect.stringContaining('/api/v1/contacts')
        }),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"name":"New Person"')
        })
      );
    });

    it('updateContact fetches existing and calls POST /api/v1/contacts/:id/update', async () => {
      // First fetch getContactById, second fetch update
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          contact: {
            id: 10,
            external_id: 'contact_0010',
            name: 'New Person',
            phones: ['8601112222']
          }
        }))
        .mockResolvedValueOnce(mockResponse(200, {
          contact: {
            id: 10,
            external_id: 'contact_0010',
            name: 'New Person',
            phones: ['8601112222', '8609998888'],
            notes: 'Updated'
          }
        }));

      const updated = await contacts.updateContact('contact_0010', {
        phones: '8609998888',
        notes: 'Updated'
      });

      expect(updated).not.toBeNull();
      expect(updated.notes).toBe('Updated');
    });
  });

  describe('deleteContact and renameContact', () => {
    it('deleteContact calls POST /api/v1/contacts/:id/delete', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          contact: { id: 10, external_id: 'contact_0010', name: 'Delete Me' }
        }))
        .mockResolvedValueOnce(mockResponse(200, { deleted: true }));

      const deleted = await contacts.deleteContact('contact_0010');
      expect(deleted).toBe(true);
    });

    it('renameContact calls update with new name', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          contact: { id: 10, external_id: 'contact_0010', name: 'Old Name' }
        }))
        .mockResolvedValueOnce(mockResponse(200, {
          contact: { id: 10, external_id: 'contact_0010', name: 'New Name' }
        }));

      const renamed = await contacts.renameContact('contact_0010', 'New Name');
      expect(renamed.name).toBe('New Name');
    });
  });

  describe('listContacts and findSubcontractorsByTrade', () => {
    it('listContacts formats all returned contacts', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        contacts: [
          { id: 1, external_id: 'contact_0001', name: 'Alice', phones: ['8605551111'] },
          { id: 2, external_id: 'contact_0002', name: 'Bob', phones: ['8605552222'] }
        ]
      }));

      const list = await contacts.listContacts();
      expect(list).toContain('Alice');
      expect(list).toContain('Bob');
    });

    it('findSubcontractorsByTrade filters subcontractors by normalized trade', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        contacts: [
          { id: 1, external_id: 'contact_0001', name: 'Roofer 1', type: 'subcontractor', trade: 'roofing', trade_raw: 'Roofing' },
          { id: 2, external_id: 'contact_0002', name: 'Plumber 1', type: 'subcontractor', trade: 'plumbing', trade_raw: 'Plumbing' },
          { id: 3, external_id: 'contact_0003', name: 'Customer 1', type: 'person' }
        ]
      }));

      const roofers = await contacts.findSubcontractorsByTrade('roofing');
      expect(roofers.length).toBe(1);
      expect(roofers[0].name).toBe('Roofer 1');
    });
  });
});
