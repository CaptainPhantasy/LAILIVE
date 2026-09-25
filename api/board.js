import { streamText } from 'ai'
import { createBoardHandler } from '../lib/board-handler.js'

const handler = createBoardHandler({ streamText })
export default { fetch: handler }
