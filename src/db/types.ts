/** Database driver selection. */
type DBDriver = 'pglite' | 'postgres'

/** Configuration for creating a database connection. */
type DBConfig =
  | { driver: 'pglite'; dataDir?: string }
  | { driver: 'postgres'; connectionString: string }

export type { DBConfig, DBDriver }
