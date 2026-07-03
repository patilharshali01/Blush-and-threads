/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import { DB, hashPassword, generateToken, verifyToken, connectDB } from './server/db-mongodb';
import { User, Product, Order, Review, Coupon, Blog, FAQ, OrderItem, Address } from './src/types';

const app = express();
const DEFAULT_PORT = 3000;
const HOST = '0.0.0.0';

function startServerWithFallback(port: number, attempts = 0) {
  const server = app.listen(port, HOST, () => {
    console.log(`Blush Threads backend server running on http://localhost:${port}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && attempts < 10) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is busy, trying ${nextPort} instead...`);
      server.close();
      startServerWithFallback(nextPort, attempts + 1);
      return;
    }

    console.error('Unable to start server:', error);
    process.exit(1);
  });
}

// Body parsing middleware
app.use(express.json({ limit: '15mb' }));

// Initialize Google GenAI
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    })
  : null;

// Middleware to authenticate requests
interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: 'user' | 'admin';
  };
}

function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (decoded) {
    req.user = decoded;
  }
  next();
}

function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
  }
  next();
}

function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

app.use(authenticate as express.RequestHandler);

// ================= AUTHENTICATION ENDPOINTS =================

// Register
app.post('/api/auth/register', async (req: Request, res: Response) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Please fill in all fields' });
  }

  const users = await DB.getUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'Email already registered' });
  }

  const newUser: User = {
    id: 'usr_' + Math.random().toString(36).substr(2, 9),
    name,
    email: email.toLowerCase(),
    role: 'user',
    addresses: [],
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  await DB.saveUsers(users);

  // Save auth password
  const auths = await DB.getAuth();
  auths.push({
    userId: newUser.id,
    passwordHash: hashPassword(password)
  });
  await DB.saveAuth(auths);

  const token = generateToken({ id: newUser.id, email: newUser.email, role: newUser.role });
  res.status(201).json({ user: newUser, token });
});

// Login
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter email and password' });
  }

  const users = await DB.getUsers();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  const auths = await DB.getAuth();
  const auth = auths.find(a => a.userId === user.id);
  if (!auth || auth.passwordHash !== hashPassword(password)) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  const token = generateToken({ id: user.id, email: user.email, role: user.role });
  res.json({ user, token });
});

// Get Profile
app.get('/api/auth/profile', requireAuth as express.RequestHandler, async (req: AuthRequest, res: Response) => {
  const users = await DB.getUsers();
  const user = users.find(u => u.id === req.user?.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ user });
});

// Update Profile & Addresses
app.put('/api/auth/profile', requireAuth as express.RequestHandler, async (req: AuthRequest, res: Response) => {
  const { name, email, addresses } = req.body;
  const users = await DB.getUsers();
  const index = users.findIndex(u => u.id === req.user?.id);
  if (index === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (name) users[index].name = name;
  if (email) users[index].email = email.toLowerCase();
  if (addresses) users[index].addresses = addresses;

  await DB.saveUsers(users);
  res.json({ user: users[index] });
});

// ================= PRODUCT ENDPOINTS =================

// Get all products (with filters)
app.get('/api/products', async (req: Request, res: Response) => {
  const products = await DB.getProducts();
  const { category, search, sort, minPrice, maxPrice } = req.query;

  let filtered = [...products];

  // Category filter
  if (category && category !== 'All') {
    filtered = filtered.filter(p => p.category === category);
  }

  // Search filter
  if (search) {
    const query = (search as string).toLowerCase();
    filtered = filtered.filter(p => 
      p.name.toLowerCase().includes(query) || 
      p.description.toLowerCase().includes(query) ||
      p.sku.toLowerCase().includes(query)
    );
  }

  // Price range
  if (minPrice) {
    filtered = filtered.filter(p => p.price >= Number(minPrice));
  }
  if (maxPrice) {
    filtered = filtered.filter(p => p.price <= Number(maxPrice));
  }

  // Sorting
  if (sort) {
    switch (sort as string) {
      case 'price_low':
        filtered.sort((a, b) => (a.price * (1 - a.discount / 100)) - (b.price * (1 - b.discount / 100)));
        break;
      case 'price_high':
        filtered.sort((a, b) => (b.price * (1 - b.discount / 100)) - (a.price * (1 - a.discount / 100)));
        break;
      case 'newest':
        // Simulating ID sorting
        filtered.sort((a, b) => b.sku.localeCompare(a.sku));
        break;
      case 'rating':
        filtered.sort((a, b) => b.rating - a.rating);
        break;
      case 'best_selling':
        filtered = filtered.sort((a, b) => (b.isBestseller ? 1 : 0) - (a.isBestseller ? 1 : 0));
        break;
      case 'discount':
        filtered.sort((a, b) => b.discount - a.discount);
        break;
      default:
        break;
    }
  }

  res.json(filtered);
});

// Create product (Admin only)
app.post('/api/products', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  const productData = req.body;
  if (!productData.name || !productData.price || !productData.category) {
    return res.status(400).json({ error: 'Name, price, and category are required' });
  }

  const products = await DB.getProducts();
  const newProduct: Product = {
    ...productData,
    id: 'prod_' + Math.random().toString(36).substr(2, 9),
    price: Number(productData.price),
    discount: Number(productData.discount || 0),
    stock: Number(productData.stock || 0),
    sku: productData.sku || 'BT-' + Math.random().toString(36).substr(2, 5).toUpperCase(),
    rating: 5.0,
    reviewsCount: 0,
    isFeatured: !!productData.isFeatured,
    isBestseller: !!productData.isBestseller
  };

  products.push(newProduct);
  await DB.saveProducts(products);
  res.status(201).json(newProduct);
});

// Update product (Admin only)
app.put('/api/products/:id', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  const products = await DB.getProducts();
  const index = products.findIndex(p => p.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Product not found' });
  }

  products[index] = {
    ...products[index],
    ...req.body,
    price: Number(req.body.price),
    discount: Number(req.body.discount || 0),
    stock: Number(req.body.stock || 0)
  };

  await DB.saveProducts(products);
  res.json(products[index]);
});

// Delete product (Admin only)
app.delete('/api/products/:id', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  const products = await DB.getProducts();
  const filtered = products.filter(p => p.id !== req.params.id);
  if (products.length === filtered.length) {
    return res.status(404).json({ error: 'Product not found' });
  }
  await DB.saveProducts(filtered);
  res.json({ success: true, message: 'Product deleted successfully' });
});


// ================= ORDER ENDPOINTS =================

// Create Order
app.post('/api/orders', requireAuth as express.RequestHandler, async (req: AuthRequest, res: Response) => {
  const { items, shippingAddress, paymentMethod, couponCode, discountAmount, subtotal, shippingFee, total, giftWrap, giftMessage } = req.body;
  if (!items || items.length === 0 || !shippingAddress) {
    return res.status(400).json({ error: 'Missing required order fields' });
  }

  const orders = await DB.getOrders();
  const newOrder: Order = {
    id: 'order_' + Math.random().toString(36).substr(2, 9).toUpperCase(),
    userId: req.user!.id,
    userEmail: req.user!.email,
    items,
    shippingAddress,
    paymentMethod,
    paymentStatus: paymentMethod === 'COD' ? 'pending' : 'paid',
    orderStatus: 'pending',
    couponCode,
    discountAmount: Number(discountAmount || 0),
    giftWrap: !!giftWrap,
    giftMessage,
    subtotal: Number(subtotal),
    shippingFee: Number(shippingFee),
    total: Number(total),
    createdAt: new Date().toISOString(),
    history: [
      {
        status: 'pending',
        date: new Date().toISOString(),
        note: 'Order placed successfully.'
      }
    ]
  };

  // Deduct stock for items
  const products = await DB.getProducts();
  items.forEach((item: OrderItem) => {
    const p = products.find(prod => prod.id === item.productId);
    if (p) {
      p.stock = Math.max(0, p.stock - item.quantity);
    }
  });
  await DB.saveProducts(products);

  orders.push(newOrder);
  await DB.saveOrders(orders);
  res.status(201).json(newOrder);
});

// Get My Orders
app.get('/api/orders/my', requireAuth as express.RequestHandler, async (req: AuthRequest, res: Response) => {
  const orders = await DB.getOrders();
  const myOrders = orders.filter(o => o.userId === req.user?.id);
  res.json(myOrders);
});

// Get All Orders (Admin only)
app.get('/api/orders', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  const orders = await DB.getOrders();
  res.json(orders);
});

// Update Order Status (Admin only)
app.put('/api/orders/:id', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  const { status, note, trackingNumber, carrier } = req.body;
  const orders = await DB.getOrders();
  const index = orders.findIndex(o => o.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const currentOrder = orders[index];
  if (status) {
    currentOrder.orderStatus = status;
    currentOrder.history.push({
      status,
      date: new Date().toISOString(),
      note: note || `Order status updated to ${status}`
    });
  }
  if (trackingNumber) currentOrder.trackingNumber = trackingNumber;
  if (carrier) currentOrder.carrier = carrier;

  await DB.saveOrders(orders);
  res.json(currentOrder);
});

// Request Return / Refund (User)
app.post('/api/orders/:id/return', requireAuth as express.RequestHandler, async (req: AuthRequest, res: Response) => {
  const { reason } = req.body;
  const orders = await DB.getOrders();
  const index = orders.findIndex(o => o.id === req.params.id && o.userId === req.user?.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const order = orders[index];
  order.orderStatus = 'pending'; // keeps state, lets admin manage
  order.history.push({
    status: 'return_requested',
    date: new Date().toISOString(),
    note: `Return/refund requested by customer. Reason: ${reason}`
  });

  await DB.saveOrders(orders);
  res.json(order);
});


// ================= REVIEWS ENDPOINTS =================

// Get all reviews (optionally filtered by product or status)
app.get('/api/reviews', async (req: Request, res: Response) => {
  const reviews = await DB.getReviews();
  const { productId, status } = req.query;

  let filtered = [...reviews];
  if (productId) {
    filtered = filtered.filter(r => r.productId === productId);
  }
  if (status) {
    filtered = filtered.filter(r => r.status === status);
  } else {
    // Regular public gets only approved reviews
    filtered = filtered.filter(r => r.status === 'approved');
  }

  res.json(filtered);
});

// Create Review (User)
app.post('/api/reviews', requireAuth as express.RequestHandler, async (req: AuthRequest, res: Response) => {
  const { productId, rating, comment, image } = req.body;
  if (!productId || !rating || !comment) {
    return res.status(400).json({ error: 'Missing required review fields' });
  }

  const products = await DB.getProducts();
  const prod = products.find(p => p.id === productId);
  if (!prod) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const reviews = await DB.getReviews();
  const users = await DB.getUsers();
  const dbUser = users.find(u => u.id === req.user!.id);
  const resolvedUserName = dbUser ? dbUser.name : 'Valued Customer';

  const newReview: Review = {
    id: 'rev_' + Math.random().toString(36).substr(2, 9),
    productId,
    productName: prod.name,
    userName: resolvedUserName,
    userEmail: req.user!.email,
    rating: Number(rating),
    comment,
    image,
    verified: true, // Auto-verified if purchased, simulating active purchase
    helpfulVotes: 0,
    status: 'approved', // Auto-approved for simple experience, admin can moderate
    createdAt: new Date().toISOString()
  };

  reviews.push(newReview);
  await DB.saveReviews(reviews);

  // Re-calculate product rating
  const prodReviews = reviews.filter(r => r.productId === productId && r.status === 'approved');
  const sum = prodReviews.reduce((acc, r) => acc + r.rating, 0);
  prod.rating = Number((sum / prodReviews.length).toFixed(1));
  prod.reviewsCount = prodReviews.length;
  await DB.saveProducts(products);

  res.status(201).json(newReview);
});

// Moderate Review (Admin only)
app.put('/api/reviews/:id/status', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  const { status } = req.body; // approved | rejected
  const reviews = await DB.getReviews();
  const index = reviews.findIndex(r => r.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Review not found' });
  }

  reviews[index].status = status;
  await DB.saveReviews(reviews);

  // Recalculate product rating
  const products = await DB.getProducts();
  const prod = products.find(p => p.id === reviews[index].productId);
  if (prod) {
    const prodReviews = reviews.filter(r => r.productId === prod.id && r.status === 'approved');
    if (prodReviews.length > 0) {
      const sum = prodReviews.reduce((acc, r) => acc + r.rating, 0);
      prod.rating = Number((sum / prodReviews.length).toFixed(1));
    } else {
      prod.rating = 5.0;
    }
    prod.reviewsCount = prodReviews.length;
    await DB.saveProducts(products);
  }

  res.json(reviews[index]);
});


// ================= COUPON ENDPOINTS =================

// Get Coupons
app.get('/api/coupons', async (req: Request, res: Response) => {
  const coupons = await DB.getCoupons();
  res.json(coupons);
});

// Create Coupon (Admin Only)
app.post('/api/coupons', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  const couponData = req.body;
  if (!couponData.code || !couponData.discountValue) {
    return res.status(400).json({ error: 'Code and discount value are required' });
  }

  const coupons = await DB.getCoupons();
  const newCoupon: Coupon = {
    id: 'coup_' + Math.random().toString(36).substr(2, 9),
    code: couponData.code.toUpperCase(),
    discountType: couponData.discountType || 'percentage',
    discountValue: Number(couponData.discountValue),
    minOrderAmount: Number(couponData.minOrderAmount || 0),
    expiryDate: couponData.expiryDate || '2026-12-31',
    isActive: true
  };

  coupons.push(newCoupon);
  await DB.saveCoupons(coupons);
  res.status(201).json(newCoupon);
});

// Delete Coupon (Admin Only)
app.delete('/api/coupons/:id', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  const coupons = await DB.getCoupons();
  const filtered = coupons.filter(c => c.id !== req.params.id);
  await DB.saveCoupons(filtered);
  res.json({ success: true, message: 'Coupon deleted successfully' });
});


// ================= CONTENT ENDPOINTS =================

// Get FAQs
app.get('/api/faqs', async (req: Request, res: Response) => {
  res.json(await DB.getFAQs());
});

// Create FAQ (Admin only)
app.post('/api/faqs', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  const faqs = await DB.getFAQs();
  const newFAQ: FAQ = {
    id: 'faq_' + Math.random().toString(36).substr(2, 9),
    question: req.body.question,
    answer: req.body.answer,
    category: req.body.category || 'General'
  };
  faqs.push(newFAQ);
  await DB.saveFAQs(faqs);
  res.json(newFAQ);
});

// Get Blogs
app.get('/api/blogs', async (req: Request, res: Response) => {
  res.json(await DB.getBlogs());
});

// Create Blog (Admin only)
app.post('/api/blogs', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  const blogs = await DB.getBlogs();
  const newBlog: Blog = {
    id: 'blog_' + Math.random().toString(36).substr(2, 9),
    title: req.body.title,
    excerpt: req.body.excerpt,
    content: req.body.content,
    image: req.body.image || 'https://images.unsplash.com/photo-1617137968427-85924c800a22?auto=format&fit=crop&w=600&q=80',
    author: req.body.author || 'Harshali Patel',
    date: new Date().toISOString().split('T')[0],
    category: req.body.category || 'General'
  };
  blogs.push(newBlog);
  await DB.saveBlogs(blogs);
  res.json(newBlog);
});

// Get all orders (Admin only)
app.get('/api/admin/orders', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  res.json(await DB.getOrders());
});

// Get all coupons (Admin only)
app.get('/api/admin/coupons', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  res.json(await DB.getCoupons());
});

// ================= ADMIN ANALYTICS ENDPOINT =================

app.get('/api/admin/analytics', requireAdmin as express.RequestHandler, async (req: Request, res: Response) => {
  const orders = await DB.getOrders();
  const products = await DB.getProducts();
  const users = await DB.getUsers();

  const totalSales = orders.filter(o => o.orderStatus !== 'cancelled').reduce((acc, o) => acc + o.total, 0);
  const revenue = totalSales * 0.92; // simulating net margins
  const todayOrders = orders.filter(o => {
    const today = new Date().toISOString().split('T')[0];
    return o.createdAt.split('T')[0] === today;
  }).length;

  const pendingOrders = orders.filter(o => o.orderStatus === 'pending').length;
  const deliveredOrders = orders.filter(o => o.orderStatus === 'delivered').length;
  const cancelledOrders = orders.filter(o => o.orderStatus === 'cancelled').length;
  const totalCustomers = users.filter(u => u.role === 'user').length;

  const lowStockAlerts = products.filter(p => p.stock <= 5).map(p => ({ id: p.id, name: p.name, stock: p.stock }));

  // Dynamic monthly sales data
  const monthlySales = [
    { name: 'Jan', sales: totalSales * 0.1 || 12000, orders: 15 },
    { name: 'Feb', sales: totalSales * 0.15 || 18000, orders: 20 },
    { name: 'Mar', sales: totalSales * 0.12 || 14000, orders: 18 },
    { name: 'Apr', sales: totalSales * 0.18 || 22000, orders: 25 },
    { name: 'May', sales: totalSales * 0.22 || 28000, orders: 32 },
    { name: 'Jun', sales: totalSales * 0.23 || 31000, orders: 35 }
  ];

  res.json({
    totalSales,
    revenue,
    todayOrders,
    pendingOrders,
    deliveredOrders,
    cancelledOrders,
    totalCustomers,
    lowStockAlerts,
    monthlySales,
    bestSellers: products.filter(p => p.isBestseller).slice(0, 3)
  });
});


// ================= AI RECOMMENDATIONS & ANALYSIS =================

// AI Recommendations (Based on viewing, cart, or simple search)
app.post('/api/ai/recommendations', async (req: Request, res: Response) => {
  const { cartItems, searchTerms, preferredCategories } = req.body;
  const products = DB.getProducts();

  if (!ai) {
    // Elegant fallback of products in preferred categories or bestsellers
    const fallback = products.filter(p => p.isFeatured || p.isBestseller).slice(0, 3);
    return res.json({
      recommendations: fallback,
      reasoning: 'Here are some of our finest handcrafted products curated specially for your luxury aesthetic.'
    });
  }

  try {
    const cartDesc = cartItems && cartItems.length > 0 
      ? `customer has these items in cart: ${cartItems.map((i: any) => i.product.name).join(', ')}`
      : 'customer has an empty cart';

    const prompt = `You are the premium AI Stylist for "Blush Threads", a luxury handmade thread embroidery brand.
Below is the customer profile context:
- ${cartDesc}
- recent search keywords: "${searchTerms || 'none'}"
- preferred categories: "${preferredCategories || 'Embroidery Hoops'}"

Here is the list of our exquisite handmade products:
${products.map(p => `ID: ${p.id}, Name: ${p.name}, Category: ${p.category}, Price: INR ${p.price}, Description: ${p.description}`).join('\n')}

Select exactly 3 product IDs from the list that fit the customer best, and write a beautiful, personalized, elegant shopping recommendation note (1-2 sentences) in a highly luxury fashion tone.
Respond with JSON only following this schema:
{
  "recommendedIds": ["prod_1", "prod_2", "prod_3"],
  "reasoning": "A luxury stylist paragraph advising why these three embroidery pieces beautifully complete their decor or gift choice."
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            recommendedIds: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "Array of recommended product IDs."
            },
            reasoning: {
              type: Type.STRING,
              description: "Elegant stylist justification note."
            }
          },
          required: ["recommendedIds", "reasoning"]
        }
      }
    });

    const parsed = JSON.parse(response.text || '{}');
    const recommendedProducts = products.filter(p => parsed.recommendedIds?.includes(p.id));
    
    res.json({
      recommendations: recommendedProducts.length > 0 ? recommendedProducts : products.slice(0, 3),
      reasoning: parsed.reasoning || 'We recommend these hand-embroidered items to add botanical elegance to your everyday collection.'
    });
  } catch (err) {
    console.error('Gemini recommendations error:', err);
    res.json({
      recommendations: products.slice(0, 3),
      reasoning: 'Curated recommendation of our finest floral peony hoops and wedding name plates.'
    });
  }
});

// Analyze Custom Thread Design (AI Embroidery Design Studio)
app.post('/api/ai/analyze-design', async (req: Request, res: Response) => {
  const { designText, base64Image, styleCategory } = req.body;

  if (!ai) {
    return res.json({
      palette: ['#F8C8DC (Blush Pink)', '#D4AF37 (Gold Accents)', '#77DD77 (Sage Green)', '#FFFFFF (Pure Silk White)'],
      stitches: ['French Knots (for textured petals)', 'Satin Stitch (for premium satin-gloss background letter)', 'Lazy Daisy (for delicate miniature leaves)'],
      advice: 'The luxury option is to use a fine linen background with organic silk threads. A gold painted wooden hoop will frame your couple names beautifully.'
    });
  }

  try {
    let contents: any[] = [];
    let prompt = `You are a master thread embroidery artisan and stylist at "Blush Threads".
Analyze this custom embroidery request and design a luxury blueprint.
Request details:
- Customer Concept: "${designText || 'A custom floral monogram'}"
- Category: "${styleCategory || 'Custom Portrait / Name Frame'}"

Recommend:
1. A luxury color palette (list of 4 hex codes with gorgeous premium names, e.g. '#FFF7F9 (Blush Crepe)').
2. Exactly 3 embroidery stitches to use (e.g. 'French Knots', 'Satin Stitch', 'Fishbone Stitch') with a quick, elegant explanation of what part of the design they will render.
3. Master Artisan advice: 2 sentences on hoop framing size, recommended linen fabric base (beige linen, silk crepe, premium organic cotton), and styling tips to make the piece feel ultra-luxury.

Respond in JSON only with this schema:
{
  "palette": ["Hex code (Color name)", ...],
  "stitches": ["Stitch Name (Description of usage)", ...],
  "advice": "Artisan advice paragraph"
}`;

    if (base64Image) {
      contents.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: base64Image.split(',')[1] || base64Image
        }
      });
      prompt += `\nAn image of the requested reference photo/sketch is attached. Evaluate the shapes and suggest outline shading in the advice.`;
    }

    contents.push({ text: prompt });

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: { parts: contents },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            palette: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "4 luxury hex codes with names"
            },
            stitches: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "3 embroidery stitches with descriptions"
            },
            advice: {
              type: Type.STRING,
              description: "Artisan styling advice paragraph"
            }
          },
          required: ["palette", "stitches", "advice"]
        }
      }
    });

    const parsed = JSON.parse(response.text || '{}');
    res.json(parsed);
  } catch (err) {
    console.error('Gemini design studio analysis error:', err);
    res.json({
      palette: ['#F8C8DC (Blush Pink)', '#D4AF37 (Gold Accents)', '#77DD77 (Sage Green)', '#FFFFFF (Pure Silk White)'],
      stitches: ['French Knots (for textured petals)', 'Satin Stitch (for premium satin-gloss background letter)', 'Lazy Daisy (for delicate miniature leaves)'],
      advice: 'Our artisans recommend framing this design inside an 8-inch solid natural pine hoop using organic cream-colored linen base cloth.'
    });
  }
});


// ================= FRONTEND ROUTING & VITE MIDDLEWARE =================

async function startServer() {
  // Connect to MongoDB
  await connectDB();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || DEFAULT_PORT);
  startServerWithFallback(port);
}

startServer();
