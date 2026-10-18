import { createMonitor } from '../../lib/monitoring.js';
import { createOwnerMailer } from '../../lib/assistant.js';
import { getDb } from '../../lib/concierge/database.js';

// The signed monthly receipt page. It states that the backup is an application
// export with a restore check, not a database snapshot.
const monitor = createMonitor({ getDb, mail: createOwnerMailer() });

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return Response.json({ error: 'GET required.' }, { status: 405 });
    return monitor.report(url.searchParams.get('token'));
  },
};
