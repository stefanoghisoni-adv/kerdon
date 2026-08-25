import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function testDatabase() {
  console.log('\n🔍 Testing Prisma Database Schema\n');
  console.log('=' .repeat(80));

  try {
    // Test 1: Count plans
    const planCount = await prisma.plan.count();
    console.log(`\n✅ Plans in database: ${planCount}`);

    // Test 2: List all plans with details
    console.log('\n📋 Plan Details:\n');
    const plans = await prisma.plan.findMany({
      orderBy: { createdAt: 'asc' }
    });

    // I prezzi non stanno piu' sul piano: stanno in plan_prices, una riga per
    // piano e valuta. Qui si mostra quella in dollari, che e' il listino.
    const basePrices = await prisma.planPrice.findMany({ where: { currency: 'USD' } });
    const usd = new Map(basePrices.map(row => [row.planName, row]));

    plans.forEach(plan => {
      const price = usd.get(plan.planName);
      console.log(`  ${plan.planName.toUpperCase()}`);
      console.log(
        price
          ? `    💰 Monthly: $${price.priceMonthly} | Yearly: $${price.priceYearly}`
          : `    ⚠️  Nessun prezzo in USD a listino`,
      );
      console.log(`    📦 Products: ${plan.maxProducts ?? '∞'} | Customers: ${plan.maxCustomers ?? '∞'}`);
      console.log(`    ⏱️  Sync Frequency: ${plan.maxSyncFrequencyHours}h`);
      console.log(`    🎨 Custom Fields: ${plan.customFieldsLimit ?? '∞'}`);
      console.log(`    📧 Support: ${plan.supportLevel}`);
      console.log(`    👥 Customers Sync: ${plan.customersSyncEnabled ? 'Yes' : 'No'}`);
      console.log('');
    });

    // Test 3: Verify field names match spec
    console.log('=' .repeat(80));
    console.log('\n✅ Schema Verification:\n');

    const samplePlan = plans[0];
    const requiredFields = [
      'planName', 'priceMonthly', 'priceYearly', 'maxProducts',
      'maxCustomers', 'maxSyncFrequencyHours', 'customFieldsLimit',
      'supportLevel', 'customersSyncEnabled'
    ];

    requiredFields.forEach(field => {
      const hasField = field in samplePlan;
      console.log(`  ${hasField ? '✅' : '❌'} Field "${field}" exists`);
    });

    // Test 4: Check if tables exist
    console.log('\n📊 Tables Check:\n');
    const shopCount = await prisma.shop.count();
    const configCount = await prisma.supabaseConfig.count();
    const chargeCount = await prisma.billingCharge.count();
    const syncJobCount = await prisma.syncJob.count();
    const customFieldCount = await prisma.customField.count();
    const fieldMappingCount = await prisma.fieldMapping.count();

    console.log(`  ✅ shops: ${shopCount} records`);
    console.log(`  ✅ supabase_configs: ${configCount} records`);
    console.log(`  ✅ plans: ${planCount} records`);
    console.log(`  ✅ billing_charges: ${chargeCount} records`);
    console.log(`  ✅ sync_jobs: ${syncJobCount} records`);
    console.log(`  ✅ custom_fields: ${customFieldCount} records`);
    console.log(`  ✅ field_mappings: ${fieldMappingCount} records`);

    console.log('\n' + '='.repeat(80));
    console.log('\n✨ Database test completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Error testing database:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testDatabase();
