import { getStore } from '../lib/concierge/database.js';
import { createVoiceReportPdfHandler } from '../lib/voice-report-pdf.js';
export default { fetch: createVoiceReportPdfHandler({ getStore }) };
