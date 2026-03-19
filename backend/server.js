const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected Successfully"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));


// ==========================================
// 1. SCHEMAS
// ==========================================

// --- Product Schema ---
const specificationSchema = new mongoose.Schema({
    key: { type: String, required: true },
    value: { type: String, required: true },
    isStar: { type: Boolean, default: false }
}, { _id: false });

const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    category: { type: String, required: true },
    subCategory: String,
    description: String,
    
    price: { type: Number, default: 0 }, 
    discountedPrice: { type: Number },   

    stock: { type: Number, default: 0 },
    images: [String],         
    specifications: [specificationSchema], 

    variants: [{
        price: Number,             
        discountedPrice: Number,   
        stock: { type: Number, default: 0 },
        images: [String],
        specifications: [specificationSchema]
    }],
    isArchived: { type: Boolean, default: false }
});

const Product = mongoose.model('Product', productSchema);

// --- Order Schema ---
const OrderSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    batchId: { type: String }, 
    products: [{
        productId: { type: String },
        name: { type: String },
        quantity: { type: Number, default: 1 },
        price: { type: Number },
        imageUrl: { type: String },
    }],
    amount: { type: Number, required: true },
    address: { type: Object, required: true }, 
    status: { type: String, default: "Processing" },
    isGift: { type: Boolean, default: false },
    giftMessage: { type: String, default: "" },
    
    // Coupon fields
    couponCode: { type: String, default: null },
    discountAmount: { type: Number, default: 0 },
    originalAmount: { type: Number },
    
    // Payment fields
    paymentMethod: { type: String },
    paymentStatus: { type: String, default: "Pending" }
}, { timestamps: true });

OrderSchema.pre('save', function(next) {
    if (!this.batchId) {
        const date = new Date();
        const dateStr = date.toISOString().split('T')[0]; 
        const windowHour = Math.floor(date.getHours() / 3) * 3; 
        const windowStr = windowHour.toString().padStart(2, '0');
        this.batchId = `BATCH-${dateStr}-${windowStr}H`;
    }
    next();
});

const Order = mongoose.model("Order", OrderSchema);

// --- Review Schema ---
const reviewSchema = new mongoose.Schema({
    product: { type: String, required: true }, 
    user: { type: String, required: true },
    userName: { type: String, required: true },
    rating: { type: Number, required: true },
    message: { type: String, required: true },
    
    // 👇 NEW FIELDS ADDED
    helpfulVotes: [{ type: String }], // Stores IDs of users who clicked Helpful
    reports: [{
        reportedBy: { type: String }, // ID of the user reporting
        reason: { type: String },     // Their explanation
        createdAt: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

module.exports = mongoose.model('Review', reviewSchema);

// --- Query Schema ---
const querySchema = new mongoose.Schema({
    userId: { type: String, required: false }, 
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    emailAddress: { type: String }, 
    message: { type: String, required: true },
    status: { type: String, default: "Unread" }, 
    adminReply: { type: String, default: "" } 
}, { timestamps: true });

const Query = mongoose.model('Query', querySchema); 

// --- Coupon Schema ---
const couponSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, uppercase: true },
    discountType: { type: String, enum: ['percentage', 'fixed'], required: true },
    discountValue: { type: Number, required: true },
    minOrderAmount: { type: Number, default: 0 },
    expiryDate: { type: Date, required: true },
    usageLimit: { type: Number, required: true },
    usedCount: { type: Number, default: 0 },
    active: { type: Boolean, default: true }
}, { timestamps: true });

const Coupon = mongoose.model('Coupon', couponSchema);

// --- Offer Schema (For Special Events/Sales) ---
const offerSchema = new mongoose.Schema({
    title: { type: String, required: true }, // e.g., "Black Friday Sale"
    discountType: { type: String, enum: ['percentage', 'fixed'], required: true },
    discountValue: { type: Number, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    selectedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    isActive: { type: Boolean, default: false } // False until admin clicks 'Apply'
}, { timestamps: true });

const Offer = mongoose.model('Offer', offerSchema);

// ==========================================
// 2. AUTOMATED BACKGROUND JOBS (CRON)
// ==========================================

cron.schedule('*/5 * * * *', async () => {
    try {
        const now = new Date();
        const thirtyMinsAgo = new Date(now.getTime() - 30 * 60000);
        await Order.updateMany(
            { status: "Processing", createdAt: { $lte: thirtyMinsAgo } },
            { $set: { status: "Confirmed" } }
        );

        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60000);
        await Order.updateMany(
            { status: "Confirmed", createdAt: { $lte: twentyFourHoursAgo } },
            { $set: { status: "Shipped to Warehouse" } }
        );
    } catch (err) { console.error("❌ Cron Job Error:", err); }
});


// ==========================================
// 3. API ROUTES
// ==========================================

// --- Authentication Route ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin123') return res.json({ success: true, role: 'inventory' });
    if (username === 'dispatch' && password === 'dispatch123') return res.json({ success: true, role: 'dispatch' });
    if (username === 'support' && password === 'support123') return res.json({ success: true, role: 'support' }); 
    
    return res.status(401).json({ success: false, message: "Invalid Credentials" });
});

// --- Coupon Routes ---
app.post('/api/admin/coupons/create', async (req, res) => {
    try {
        const coupon = new Coupon(req.body);
        await coupon.save();
        res.status(201).json({ success: true, coupon });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ message: "Coupon code already exists!" });
        res.status(400).json({ message: err.message });
    }
});

app.get('/api/admin/coupons', async (req, res) => {
    try {
        const coupons = await Coupon.find().sort({ createdAt: -1 });
        res.json(coupons);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/admin/coupons/:id', async (req, res) => {
    try {
        const updated = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(updated);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

app.delete('/api/admin/coupons/:id', async (req, res) => {
    try {
        await Coupon.findByIdAndDelete(req.params.id);
        res.json({ message: "Coupon deleted" });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/coupons/apply', async (req, res) => {
    try {
        const { code, orderTotal } = req.body;
        const coupon = await Coupon.findOne({ code: code.toUpperCase() });

        if (!coupon) return res.status(404).json({ success: false, message: "Invalid coupon code" });
        if (!coupon.active) return res.status(400).json({ success: false, message: "This coupon is disabled" });
        if (new Date() > new Date(coupon.expiryDate)) return res.status(400).json({ success: false, message: "Coupon has expired" });
        if (orderTotal < coupon.minOrderAmount) return res.status(400).json({ success: false, message: `Minimum order amount is ₹${coupon.minOrderAmount}` });
        if (coupon.usedCount >= coupon.usageLimit) return res.status(400).json({ success: false, message: "Coupon usage limit reached" });

        let discount = coupon.discountType === 'percentage' ? (orderTotal * coupon.discountValue) / 100 : coupon.discountValue;
        if (discount > orderTotal) discount = orderTotal;

        res.json({ success: true, discount: Math.round(discount), finalTotal: Math.round(orderTotal - discount), code: coupon.code });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// --- Query Routes ---
app.get('/api/queries', async (req, res) => {
    try {
        const queries = await Query.find().sort({ createdAt: -1 });
        res.json(queries);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/queries/:id/reply', async (req, res) => {
    try {
        const { reply } = req.body; 
        const updatedQuery = await Query.findByIdAndUpdate(
            req.params.id, 
            { adminReply: reply, status: "Resolved" }, 
            { new: true } 
        );
        res.json(updatedQuery);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

// --- Product Routes ---
app.get('/api/products', async (req, res) => {
    try {
        const showArchived = req.query.archived === 'true';
        const query = showArchived ? { isArchived: true } : { $or: [{ isArchived: false }, { isArchived: { $exists: false } }] };
        const products = await Product.find(query);
        res.json(products);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/products', async (req, res) => {
    try { 
        const newProduct = new Product(req.body); 
        await newProduct.save(); 
        res.status(201).json(newProduct); 
    } catch (err) { res.status(400).json({ message: err.message }); }
});

app.put('/api/products/:id', async (req, res) => {
    try { 
        const updated = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true }); 
        res.json(updated); 
    } catch (err) { res.status(400).json({ message: err.message }); }
});

app.patch('/api/products/:id/archive', async (req, res) => { 
    try { await Product.findByIdAndUpdate(req.params.id, { isArchived: true }); res.json({ message: "Archived" }); } 
    catch (err) { res.status(500).json(err); }
});

app.patch('/api/products/:id/restore', async (req, res) => { 
    try { await Product.findByIdAndUpdate(req.params.id, { isArchived: false }); res.json({ message: "Restored" }); } 
    catch (err) { res.status(500).json(err); }
});

app.delete('/api/products/:id', async (req, res) => { 
    try { await Product.findByIdAndDelete(req.params.id); res.json({ message: "Deleted" }); } 
    catch (err) { res.status(500).json(err); }
});

// --- Order & Batch Routes ---
app.get('/api/orders', async (req, res) => {
    try {
        const orders = await Order.find().sort({ createdAt: -1 });
        res.json(orders);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/orders/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const updatedOrder = await Order.findByIdAndUpdate(req.params.id, { status: status }, { new: true });
        res.json(updatedOrder);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

app.put('/api/batches/:batchId/status', async (req, res) => {
    try {
        const { status } = req.body;
        await Order.updateMany(
            { batchId: req.params.batchId }, 
            { $set: { status: status } }
        );
        res.json({ message: "Batch status updated successfully" });
    } catch (err) { res.status(400).json({ message: err.message }); }
});

// --- Review Routes ---
app.get('/api/reviews', async (req, res) => {
    try {
        // Grab the models dynamically to prevent "Not Defined" crash errors
        const mongoose = require('mongoose');
        const Review = mongoose.model('Review');
        const Product = mongoose.model('Product'); 

        // 1. Fetch reviews as plain objects
        const reviews = await Review.find().sort({ createdAt: -1 }).lean();
        
        // 2. Safely attach product data
        for (let review of reviews) {
            try {
                // Check if product ID is a valid MongoDB ObjectId before searching
                if (mongoose.Types.ObjectId.isValid(review.product)) {
                    const productInfo = await Product.findById(review.product).select('name images');
                    review.product = productInfo || { _id: review.product, name: 'Unknown Product', images: [] };
                } else {
                    review.product = { _id: review.product, name: 'Unknown Product', images: [] };
                }
            } catch (err) {
                review.product = { _id: review.product, name: 'Unknown Product', images: [] };
            }
        }

        res.json(reviews);
        
    } catch (err) { 
        console.error("🔥 FATAL REVIEW FETCH ERROR:", err);
        res.status(500).json({ message: err.message }); 
    }
});

app.delete('/api/reviews/:id', async (req, res) => {
    try {
        // 🔥 Add these two lines to safely grab the model and prevent the crash!
        const mongoose = require('mongoose');
        const Review = mongoose.model('Review');

        await Review.findByIdAndDelete(req.params.id);
        res.json({ message: "Review deleted successfully" });
    } catch (err) { 
        console.error("🔥 Error deleting review:", err);
        res.status(500).json({ message: err.message }); 
    }
});

// ==========================================
// SPECIAL OFFERS ROUTES
// ==========================================

// Create/Update Offer
app.post('/api/admin/offers', async (req, res) => {
    try {
        const offer = new Offer(req.body);
        await offer.save();
        res.status(201).json(offer);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

app.get('/api/admin/offers', async (req, res) => {
    try {
        const offers = await Offer.find().populate('selectedProducts', 'name images price').sort({ createdAt: -1 });
        res.json(offers);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/admin/offers/:id', async (req, res) => {
    try {
        await Offer.findByIdAndDelete(req.params.id);
        res.json({ message: "Offer deleted" });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// 🔥 MAGIC ROUTE 1: Apply Offer to Products
app.post('/api/admin/offers/:id/apply', async (req, res) => {
    try {
        const offer = await Offer.findById(req.params.id).populate('selectedProducts');
        for (const product of offer.selectedProducts) {
            // Apply to main product
            let discount = offer.discountType === 'percentage' ? product.price * (offer.discountValue / 100) : offer.discountValue;
            let newPrice = product.price - discount;
            product.discountedPrice = newPrice > 0 ? Math.round(newPrice) : 0;
            
            // Apply to all variants
            if (product.variants && product.variants.length > 0) {
                product.variants.forEach(v => {
                    let vDiscount = offer.discountType === 'percentage' ? v.price * (offer.discountValue / 100) : offer.discountValue;
                    let vNewPrice = v.price - vDiscount;
                    v.discountedPrice = vNewPrice > 0 ? Math.round(vNewPrice) : 0;
                });
            }
            await product.save();
        }
        offer.isActive = true;
        await offer.save();
        res.json({ message: "Offer prices applied successfully!" });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// 🔥 MAGIC ROUTE 2: Remove Offer from Products (Reset Prices)
app.post('/api/admin/offers/:id/remove', async (req, res) => {
    try {
        const offer = await Offer.findById(req.params.id).populate('selectedProducts');
        for (const product of offer.selectedProducts) {
            product.discountedPrice = undefined; // Remove main discount
            if (product.variants && product.variants.length > 0) {
                product.variants.forEach(v => v.discountedPrice = undefined ); // Remove variant discounts
            }
            await product.save();
        }
        offer.isActive = false;
        await offer.save();
        res.json({ message: "Offer prices removed. Reset to original!" });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// ==========================================
// ANALYTICS & DASHBOARD ROUTES
// ==========================================
// ==========================================
// ANALYTICS & DASHBOARD ROUTES
// ==========================================
app.get('/api/admin/dashboard-stats', async (req, res) => {
    try {
        // 1. Today's Revenue
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        
        const todayOrders = await Order.find({ 
            createdAt: { $gte: startOfDay }, 
            status: { $ne: 'Cancelled' } 
        });
        const todayRevenue = todayOrders.reduce((sum, order) => sum + (order.amount || 0), 0);

        // 2. Pending Orders
        const pendingOrdersCount = await Order.countDocuments({ status: 'Processing' });

        // 3. Low Stock Alerts (Stock <= 5)
        // 🔥 FIX: Now includes older products that don't have the isArchived field yet!
        const products = await Product.find({ 
            $or: [{ isArchived: false }, { isArchived: { $exists: false } }] 
        });
        
        let lowStockCount = 0;
        let lowStockItems = [];
        
        products.forEach(p => {
            // Check Variants first
            if (p.variants && p.variants.length > 0) {
                p.variants.forEach((v, idx) => {
                    const vStock = Number(v.stock) || 0;
                    if (vStock <= 5) {
                        lowStockCount++;
                        lowStockItems.push({ name: `${p.name} (Variant ${idx + 1})`, stock: vStock });
                    }
                });
            } else {
                // Check Main Product
                const pStock = Number(p.stock) || 0;
                if (pStock <= 5) {
                    lowStockCount++;
                    lowStockItems.push({ name: p.name, stock: pStock });
                }
            }
        });

        // Sort to show the absolute lowest stock items first
        lowStockItems.sort((a, b) => a.stock - b.stock);

        // 4. Active Promos
        const activeCoupons = await Coupon.countDocuments({ active: true, expiryDate: { $gt: new Date() } });
        const activeOffers = await Offer.countDocuments({ isActive: true });
        const totalPromos = activeCoupons + activeOffers;

        // 5. Recent Orders
        const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(5);

        res.json({
            todayRevenue,
            pendingOrdersCount,
            lowStockCount,
            totalPromos,
            lowStockItems: lowStockItems.slice(0, 5), // Only send top 5
            recentOrders
        });

    } catch (err) { res.status(500).json({ message: err.message }); }
});

// ==========================================
// 4. SERVER START
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));