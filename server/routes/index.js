const authRoutes = require('./auth');
const inventoryRoutes = require('./inventory');
const salesRoutes = require('./sales');
const cashRoutes = require('./cash');
const purchasesRoutes = require('./purchases');
const accountingRoutes = require('./accounting');
const hospitalRoutes = require('./hospital');
const systemRoutes = require('./system');
const felRoutes = require('./fel');

module.exports = (app) => {
  app.use('/api', authRoutes);
  app.use('/api', inventoryRoutes);
  app.use('/api', salesRoutes);
  app.use('/api', cashRoutes);
  app.use('/api', purchasesRoutes);
  app.use('/api', accountingRoutes);
  app.use('/api', hospitalRoutes);
  app.use('/api', systemRoutes);
  app.use('/api', felRoutes);
};
