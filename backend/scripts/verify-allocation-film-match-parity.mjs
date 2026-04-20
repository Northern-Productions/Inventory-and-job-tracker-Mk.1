import '../load-env.mjs';
import { Client } from 'pg';

function asTrimmedString(value) {
  return String(value || '').trim();
}

function requireDatabaseUrl() {
  const databaseUrl = asTrimmedString(process.env.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }
  return databaseUrl;
}

function requireOrgId() {
  const orgId = asTrimmedString(process.env.VERIFY_DB_PARITY_ORG_ID || process.env.DEFAULT_ORG_ID);
  if (!orgId) {
    throw new Error('VERIFY_DB_PARITY_ORG_ID or DEFAULT_ORG_ID is required.');
  }
  return orgId;
}

async function main() {
  const client = new Client({
    connectionString: requireDatabaseUrl(),
    ssl: { rejectUnauthorized: false }
  });
  const orgId = requireOrgId();

  const cases = [
    {
      label: 'Llumar RN07 matches RN 07',
      candidateManufacturer: 'Llumar',
      candidateFilmName: 'RN07',
      requirementManufacturer: 'Llumar',
      requirementFilmName: 'RN 07',
      expected: true
    },
    {
      label: 'Llumar-prefixed RN07 matches RN 07',
      candidateManufacturer: 'Llumar',
      candidateFilmName: 'Llumar RN07',
      requirementManufacturer: 'Llumar',
      requirementFilmName: 'RN 07',
      expected: true
    },
    {
      label: 'Descriptive RN07 mirror variant matches RN 07',
      candidateManufacturer: 'Llumar',
      candidateFilmName: 'RN 07 Refl. One Way Mirror',
      requirementManufacturer: 'Llumar',
      requirementFilmName: 'RN 07',
      expected: true
    },
    {
      label: 'Base RN 07 does not auto-match descriptive mirror requirement',
      candidateManufacturer: 'Llumar',
      candidateFilmName: 'RN 07',
      requirementManufacturer: 'Llumar',
      requirementFilmName: 'RN 07 Refl. One Way Mirror',
      expected: false
    },
    {
      label: 'Night Vision exterior aliases remain compatible',
      candidateManufacturer: '3M Solar',
      candidateFilmName: 'NV15 Exterior',
      requirementManufacturer: '3M Solar',
      requirementFilmName: 'Night Vision 15 Exterior',
      expected: true
    },
    {
      label: 'Exterior candidate can satisfy non-exterior Prestige requirement',
      candidateManufacturer: '3M Solar',
      candidateFilmName: 'Prestige 60 Exterior',
      requirementManufacturer: '3M Solar',
      requirementFilmName: 'Prestige 60',
      expected: true
    },
    {
      label: 'Non-exterior candidate cannot satisfy exterior Prestige requirement',
      candidateManufacturer: '3M Solar',
      candidateFilmName: 'Prestige 60',
      requirementManufacturer: '3M Solar',
      requirementFilmName: 'Prestige 60 Exterior',
      expected: false
    },
    {
      label: 'Prestige 40 Exterior satisfies base Prestige 40 requirement',
      candidateManufacturer: '3M Solar',
      candidateFilmName: 'Prestige 40 Exterior',
      requirementManufacturer: '3M Solar',
      requirementFilmName: 'Prestige 40',
      expected: true
    },
    {
      label: 'Prestige 40 Exterior alias code satisfies base Prestige 40 requirement',
      candidateManufacturer: '3M Solar',
      candidateFilmName: '3M Prestige 40 Exterior (PR40 Ext)',
      requirementManufacturer: '3M Solar',
      requirementFilmName: 'Prestige 40',
      expected: true
    },
    {
      label: 'Base Prestige 40 does not satisfy Prestige 40 Exterior requirement',
      candidateManufacturer: '3M Solar',
      candidateFilmName: 'Prestige 40',
      requirementManufacturer: '3M Solar',
      requirementFilmName: 'Prestige 40 Exterior',
      expected: false
    },
    {
      label: 'Base Prestige 40 does not satisfy exterior alias requirement',
      candidateManufacturer: '3M Solar',
      candidateFilmName: 'Prestige 40',
      requirementManufacturer: '3M Solar',
      requirementFilmName: '3M Prestige 40 Exterior (PR40 Ext)',
      expected: false
    }
  ];

  await client.connect();

  try {
    const applyDefResult = await client.query(
      `
        select pg_get_functiondef('public.api_allocations_apply(uuid, text, jsonb)'::regprocedure) as apply_def
      `
    );
    const applyDef = asTrimmedString(applyDefResult.rows[0]?.apply_def);
    if (!applyDef.includes('app_api.requirement_film_is_compatible')) {
      throw new Error('public.api_allocations_apply is not using app_api.requirement_film_is_compatible.');
    }

    for (const testCase of cases) {
      const result = await client.query(
        `
          select
            app_api.requirement_film_is_compatible(
              $1::uuid,
              $2::text,
              $3::text,
              $4::text,
              $5::text
            ) as compatible,
            app_api.normalize_requirement_film_family_key($1::uuid, $2::text, $3::text) as candidate_family_key,
            app_api.normalize_requirement_film_family_key($1::uuid, $4::text, $5::text) as requirement_family_key
        `,
        [
          orgId,
          testCase.candidateManufacturer,
          testCase.candidateFilmName,
          testCase.requirementManufacturer,
          testCase.requirementFilmName
        ]
      );

      const row = result.rows[0] || {};
      if (Boolean(row.compatible) !== testCase.expected) {
        throw new Error(
          `${testCase.label}: expected ${testCase.expected}, received ${Boolean(row.compatible)} `
          + `(candidateFamilyKey=${asTrimmedString(row.candidate_family_key)}, `
          + `requirementFamilyKey=${asTrimmedString(row.requirement_family_key)})`
        );
      }
    }

    console.log(`Allocation film-match parity OK for ${cases.length} SQL cases.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(
    'Allocation film-match parity verification failed:',
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});
