import { createTestimonialApproval } from '../../lib/testimonial-review.js';
import { createOwnerMailer } from '../../lib/assistant.js';

// A customer's note is routed to the owner for a permission check. Publishing still
// requires the approved entry to be committed to catalog/testimonials.json.
export default { fetch: createTestimonialApproval({ mail: createOwnerMailer() }) };
