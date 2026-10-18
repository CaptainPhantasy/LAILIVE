import { getStore } from '../lib/concierge/database.js';
import { createVoiceReportHandler } from '../lib/voice-report.js';
import { createVoiceReportGeneration } from '../lib/voice-report-generation.js';

export default { fetch: createVoiceReportHandler({ getStore, generate: createVoiceReportGeneration() }) };
