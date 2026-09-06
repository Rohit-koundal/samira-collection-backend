const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 80 },
  structure: { type: mongoose.Schema.Types.Mixed, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
module.exports = mongoose.model('IndustryPreset', schema);
