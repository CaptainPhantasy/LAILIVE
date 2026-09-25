import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { attachDatabasePool } from '@vercel/functions'
import { createStore } from './store.js'
import { HttpError } from './contracts.js'

let store
export function getStore() {
  if (store) return store
  if (!process.env.DATABASE_URL) throw new HttpError(503, 'The inquiry service is not connected yet. Your details have not been saved.')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000 })
  attachDatabasePool(pool)
  store = createStore(drizzle(pool))
  return store
}
