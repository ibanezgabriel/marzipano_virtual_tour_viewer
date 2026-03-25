const db = require('../db');

async function tableExists(client, name) {
  const res = await client.query("SELECT to_regclass($1) AS reg", [`public.${name}`]);
  return Boolean(res.rows[0] && res.rows[0].reg);
}

async function columnExists(client, table, column) {
  const res = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [table, column]
  );
  return res.rows.length > 0;
}

async function migrate() {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const hasLayouts = await tableExists(client, 'layouts');
    const hasFloorplans = await tableExists(client, 'floorplans');
    if (!hasLayouts && hasFloorplans) {
      console.log('Renaming table floorplans -> layouts');
      await client.query('ALTER TABLE floorplans RENAME TO layouts');
    } else if (hasLayouts) {
      console.log('Table layouts already exists; skipping layouts rename');
    } else {
      console.log('No floorplans table found; skipping layouts rename');
    }

    const hasLayoutHotspots = await tableExists(client, 'layout_hotspots');
    const hasFloorplanHotspots = await tableExists(client, 'floorplan_hotspots');
    if (!hasLayoutHotspots && hasFloorplanHotspots) {
      console.log('Renaming table floorplan_hotspots -> layout_hotspots');
      await client.query('ALTER TABLE floorplan_hotspots RENAME TO layout_hotspots');
    } else if (hasLayoutHotspots) {
      console.log('Table layout_hotspots already exists; skipping layout hotspots rename');
    } else {
      console.log('No floorplan_hotspots table found; skipping layout hotspots rename');
    }

    if (await tableExists(client, 'layout_hotspots')) {
      const hasOldCol = await columnExists(client, 'layout_hotspots', 'floorplan_id');
      const hasNewCol = await columnExists(client, 'layout_hotspots', 'layout_id');
      if (hasOldCol && !hasNewCol) {
        console.log('Renaming column layout_hotspots.floorplan_id -> layout_id');
        await client.query('ALTER TABLE layout_hotspots RENAME COLUMN floorplan_id TO layout_id');
      } else {
        console.log('layout_hotspots.layout_id already present (or no floorplan_id); skipping column rename');
      }
    }

    await client.query('COMMIT');
    console.log('Done.');
    process.exit(0);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    console.error('Migration failed:', err.message || err);
    process.exit(1);
  } finally {
    try {
      client.release();
    } catch {}
  }
}

migrate();
