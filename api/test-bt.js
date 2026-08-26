// Discover project ID and test logging
export default async function handler(req, res) {
  const apiKey = process.env.BRAINTRUST_API_KEY;
  const results = {};

  // Step 1: Create or find the project
  const createRes = await fetch('https://api.braintrust.dev/v1/project', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Claudesington' }),
  });
  const project = await createRes.json();
  results.project = { id: project.id, name: project.name, org: project.org_name };

  // Step 2: Insert a test log
  if (project.id) {
    const logRes = await fetch(`https://api.braintrust.dev/v1/project_logs/${project.id}/insert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{
          input: { message: 'test from /api/test-bt' },
          output: { response: 'logging works!' },
          metadata: { test: true, timestamp: new Date().toISOString() },
        }],
      }),
    });
    const logData = await logRes.json();
    results.log = { status: logRes.status, data: logData };
    results.projectId = project.id;
    results.message = logData.row_ids
      ? `SUCCESS. Update PROJECT_ID in bot/lib/braintrust.js to: ${project.id}`
      : 'Log insert failed';
  }

  return res.status(200).json(results);
}
