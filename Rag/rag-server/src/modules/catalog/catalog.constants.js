module.exports = Object.freeze({
  VERSION_STATUS: Object.freeze({
    DRAFT: 'draft',
    PUBLISHED: 'published',
    RETIRED: 'retired'
  }),
  ENTITY_STATUS: Object.freeze({
    ACTIVE: 'active',
    INACTIVE: 'inactive'
  }),
  CUSTOMER_TYPES: new Set(['all', 'retail', 'wholesale']),
  DELIVERY_TERMS: new Set(['DDU', 'DDP', 'OTHER']),
  UNITS: new Set(['piece', 'ml', 'kg', 'sqm'])
})
