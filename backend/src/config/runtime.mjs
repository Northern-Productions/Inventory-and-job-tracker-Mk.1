// Purpose: Runtime environment constants and shared backend configuration.
import '../../load-env.mjs';
import { Pool } from 'pg';
import {
  BOX_STATUSES as CONTRACT_BOX_STATUSES,
  FEATURE_AREAS as CONTRACT_FEATURE_AREAS
} from '../../../shared/domain/runtimeContract.mjs';

export const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/g, '');
export const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || '').trim();
export const DATABASE_URL = String(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim();
export const DEFAULT_ORG_ID = String(process.env.DEFAULT_ORG_ID || '').trim();
export const API_BUILD_SHA = String(process.env.API_BUILD_SHA || '').trim();
export const API_BUILT_AT = String(process.env.API_BUILT_AT || '').trim();

export const LOW_STOCK_THRESHOLD_LF = 10;
export const ZEROED_BOX_AUTO_CANCEL_NOTE =
  'Auto-cancelled because the box was moved to zeroed out inventory.';

export const CORE_WEIGHT_REFERENCE_WIDTH_IN = 72;
export const CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS = {
  'White plastic': 2,
  'Red plastic': 1.85,
  'Cardboard 1/8"': 2.05,
  'Cardboard 3/8"': 6.15,
  'SECURITY 1/4" Cardboard': 11.6,
  'SECURITY White plastic 3/8"': 14.4
};

export const BOX_STATUSES = new Set(CONTRACT_BOX_STATUSES);
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MEMBER_FEATURE_AREAS = CONTRACT_FEATURE_AREAS.filter((feature) => feature !== 'access_management');

export const ADMIN_FEATURE_AREAS = [...CONTRACT_FEATURE_AREAS];

export const pool =
  DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false }
      })
    : null;
