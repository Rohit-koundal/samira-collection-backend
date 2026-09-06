const Configuration = require('../models/MasterConfiguration');
const Product = require('../models/Product');
const { DEFAULT_STRUCTURE } = require('../config/industryPresets');
const { assertMasterOwner } = require('../config/masterOwner');
const { ApiError } = require('../utils/apiError');
const clone = (value) => JSON.parse(JSON.stringify(value));
const bad = (message) => { throw new ApiError('VALIDATION_ERROR', message); };
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function validateStructure(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('A valid store structure is required');
  if (!['fashion', 'electronics', 'art', 'jewellery'].includes(input.industry)) bad('Choose a supported industry');
  if (!Array.isArray(input.attributes) || input.attributes.length > 30) bad('Use at most 30 product attributes');
  const keys = new Set();
  const attributes = input.attributes.map((item) => {
    const key = text(item?.key, 40);
    const label = text(item?.label, 80);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || keys.has(key) || !label) bad('Attribute keys must be unique lowercase identifiers and have labels');
    keys.add(key);
    if (item.required !== undefined && typeof item.required !== 'boolean') bad('Attribute required must be true or false');
    return { key, label, unit: text(item.unit, 20), required: item.required === true };
  });
  for (const key of ['sizing', 'specifications']) if (typeof input.features?.[key] !== 'boolean') bad('Choose valid feature switches');
  if (!input.features.specifications) bad('Product specifications must remain enabled for configured attributes');
  if (input.industry !== 'fashion' && input.features.sizing) bad('Garment sizing is only available for fashion stores');
  for (const key of ['content', 'payments']) if (typeof input.clientPermissions?.[key] !== 'boolean') bad('Choose valid client permissions');
  return { industry: input.industry, attributes, features: { sizing: input.features.sizing, specifications: input.features.specifications },
    clientPermissions: { content: input.clientPermissions.content, payments: input.clientPermissions.payments } };
}
async function readConfiguration() {
  return await Configuration.findById('store').lean() || { _id: 'store', structure: clone(DEFAULT_STRUCTURE), revision: 0, locked: true, history: [] };
}
async function ensureConfiguration() {
  return Configuration.findOneAndUpdate({ _id: 'store' }, { $setOnInsert: { structure: clone(DEFAULT_STRUCTURE), locked: true, revision: 0 } }, { upsert: true, new: true });
}
async function updateConfiguration(user, { revision, structure, locked, note = '' }) {
  assertMasterOwner(user);
  if (!Number.isInteger(revision) || revision < 0) bad('The current configuration revision is required');
  await ensureConfiguration();
  const before = await readConfiguration();
  if (revision !== before.revision) throw new ApiError('DUPLICATE_REQUEST', 'Configuration changed in another session. Reload before continuing.');
  const changingStructure = structure !== undefined;
  if (changingStructure && before.locked) throw new ApiError('FORBIDDEN', 'Unlock the configuration before changing its structure');
  if (changingStructure && locked !== undefined) bad('Save changes and lock as separate actions');
  if (!changingStructure && typeof locked !== 'boolean') bad('Choose a lock action or provide a structure');
  const next = changingStructure ? validateStructure(structure) : before.structure;
  if (changingStructure) {
    if ((next.industry !== before.structure.industry || next.features.sizing !== before.structure.features.sizing) &&
      await Product.exists({ isArchived: { $ne: true } })) {
      bad('This store contains products. Export/review the catalog and archive incompatible products before conversion. Products and orders are never deleted automatically.');
    }
    const changedKeys = before.structure.attributes.filter((field) =>
      JSON.stringify(next.attributes.find((item) => item.key === field.key)) !== JSON.stringify(field)).map((item) => item.key);
    if (changedKeys.length && await Product.exists({ 'specifications.key': { $in: changedKeys }, isArchived: { $ne: true } })) {
      bad('An attribute being changed is used by products. Migrate those product values before changing or removing its definition.');
    }
  }
  const event = { revision: before.revision, structure: before.structure, locked: before.locked, at: new Date(), actor: String(user._id), note: text(note, 240) || (changingStructure ? 'Structure updated' : locked ? 'Configuration locked' : 'Configuration unlocked') };
  const saved = await Configuration.findOneAndUpdate({ _id: 'store', revision }, {
    $set: { structure: next, locked: changingStructure ? false : locked, updatedBy: user._id },
    $inc: { revision: 1 }, $push: { history: { $each: [event], $slice: -30 } },
  }, { new: true, runValidators: true });
  if (!saved) throw new ApiError('DUPLICATE_REQUEST', 'Configuration changed while saving. Reload and review it.');
  return saved;
}
function publicStructure(config) {
  const { industry, attributes, features } = config.structure;
  return { industry, attributes, features, revision: config.revision };
}
async function applyProductStructure(payload, existing = {}) {
  const configuration = await readConfiguration();
  const { structure } = configuration;
  const values = payload.attributeValues ?? existing.attributeValues ?? {};
  const source = values instanceof Map ? Object.fromEntries(values) : values;
  if (!source || typeof source !== 'object' || Array.isArray(source)) bad('Attribute values must be an object');
  const keys = new Set(structure.attributes.map((item) => item.key));
  if (Object.keys(source).some((key) => !keys.has(key))) bad('Only configured product attributes can be edited');
  const attributeValues = {};
  const specifications = [];
  for (const definition of structure.attributes) {
    const value = source[definition.key];
    if (value !== undefined && typeof value !== 'string' && typeof value !== 'number') bad('Product attribute values must be text or numbers');
    if (String(value ?? '').length > 500) bad('Keep each attribute value under 500 characters');
    const cleaned = String(value ?? '').trim();
    if (definition.required && !cleaned) bad(`Enter ${definition.label}`);
    if (cleaned) { attributeValues[definition.key] = cleaned; specifications.push({ ...definition, value: cleaned }); }
  }
  const next = { ...payload, attributeValues, specifications };
  if (!structure.features.sizing) Object.assign(next, { sizingMode: 'free-size', sizeChartProfile: 'free-size', sizes: [], variants: [], sizeChart: { unit: 'in', columns: [], rows: [] } });
  return next;
}
module.exports = { validateStructure, readConfiguration, updateConfiguration, publicStructure, applyProductStructure };
