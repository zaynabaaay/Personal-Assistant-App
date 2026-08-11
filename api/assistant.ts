export {
  ASSISTANT_REQUEST_LIMITS,
  handleAssistantRequest,
} from '../src/server/assistant/assistant-handler';

import { handleAssistantRequest } from '../src/server/assistant/assistant-handler';

export default { fetch: handleAssistantRequest };
