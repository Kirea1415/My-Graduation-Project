import pkg from 'pg';
const { Client } = pkg;

const pgConfig = {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'safekeys',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'your_password',
};

console.log('🔌 Testing PostgreSQL connection...\n');
console.log('Configuration:');
console.log(`  Host: ${pgConfig.host}`);
console.log(`  Port: ${pgConfig.port}`);
console.log(`  Database: ${pgConfig.database}`);
console.log(`  User: ${pgConfig.user}\n`);

const client = new Client(pgConfig);

async function testConnection() {
    try {
        await client.connect();
        console.log('✅ Connection successful!\n');

        // Test query
        const result = await client.query('SELECT version()');
        console.log('PostgreSQL Version:');
        console.log(`  ${result.rows[0].version}\n`);

        // Check if database exists and has tables
        const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

        if (tablesResult.rows.length > 0) {
            console.log(`📊 Found ${tablesResult.rows.length} tables:`);
            tablesResult.rows.forEach(row => {
                console.log(`  - ${row.table_name}`);
            });
        } else {
            console.log('📊 No tables found. Database is empty.');
            console.log('   Run "npm run sync-db" to sync data.');
        }

        await client.end();
        console.log('\n✅ Test completed successfully!');
        console.log('   You can now run: npm run sync-db');

    } catch (error) {
        console.error('\n❌ Connection failed:', error.message);

        if (error.code === 'ECONNREFUSED') {
            console.error('\n💡 Make sure PostgreSQL is running:');
            console.error('   - Check if PostgreSQL service is started');
            console.error('   - Verify host and port are correct');
        } else if (error.code === '3D000') {
            console.error('\n💡 Database does not exist. Create it:');
            console.error(`   CREATE DATABASE ${pgConfig.database};`);
        } else if (error.code === '28P01') {
            console.error('\n💡 Authentication failed:');
            console.error('   - Check username and password');
            console.error('   - Verify pg_hba.conf settings');
        }

        process.exit(1);
    }
}

testConnection();

