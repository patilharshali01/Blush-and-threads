# MongoDB Setup Guide for Blush Threads

## Two Options for MongoDB:

### **Option 1: MongoDB Atlas (Cloud - Recommended for Render)**

1. **Create Free Account:**
   - Go to [mongodb.com/atlas](https://mongodb.com/atlas)
   - Sign up for free
   - Create a new project

2. **Create a Free Cluster:**
   - Click "Create" → Select "Free" tier
   - Choose region closest to you
   - Click "Create Cluster" (takes ~5 minutes)

3. **Get Connection String:**
   - Click "Connect" on your cluster
   - Select "Drivers" → Node.js
   - Copy the connection string
   - It looks like: `mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/blush-threads?retryWrites=true&w=majority`

4. **Replace Credentials:**
   - In your connection string, replace `<username>` with your MongoDB username
   - Replace `<password>` with your MongoDB password

5. **Update `.env` File:**
   ```bash
   MONGODB_URI=mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/blush-threads?retryWrites=true&w=majority
   ```

---

### **Option 2: Local MongoDB (Development)**

1. **Install MongoDB Community:**
   - Windows: [Download from mongodb.com](https://www.mongodb.com/try/download/community)
   - Run the installer
   - During installation, check "Install MongoD as a Service"

2. **Verify Installation:**
   ```bash
   mongod --version
   ```

3. **Update `.env`:**
   ```bash
   MONGODB_URI=mongodb://localhost:27017/blush-threads
   ```

4. **Start MongoDB:**
   - Windows: Service starts automatically
   - Or run: `mongod`

---

## Running the Application

### **Local Development:**
```bash
# Install dependencies (if not done already)
npm install

# Start the server
npm run dev
```

The server will:
- Connect to MongoDB
- Seed initial data (products, users, etc.)
- Run on http://localhost:3000

### **Production Build:**
```bash
# Build frontend & backend
npm run build

# Start production server
npm run start
```

---

## Deploying to Render with MongoDB

1. **Push code to GitHub**
2. **Go to Render.com**
3. **Create Web Service:**
   - Select your GitHub repo
   - Build: `npm install && npm run build`
   - Start: `npm run start`

4. **Add Environment Variables:**
   - Click "Advanced"
   - Add: `MONGODB_URI = your-atlas-connection-string`

5. **Deploy!**

---

## Troubleshooting

### Connection Failed Error
- ✅ Check MongoDB connection string is correct
- ✅ Add your IP to MongoDB Atlas IP whitelist (click "Network Access")
- ✅ Ensure username/password are URL-encoded (use `%40` for `@`, etc.)

### Data Not Persisting
- ✅ Make sure you're using the MongoDB version (`db-mongodb.ts`)
- ✅ Check `server.ts` imports: `import { DB, ... } from './server/db-mongodb'`

### Seeding Failed
- ✅ Clear database and try again: Delete all collections, restart server
- ✅ Check database name matches your connection string

---

## Login Credentials

After setup, use these pre-seeded accounts:

**Admin:**
- Email: `admin@blushthreads.com`
- Password: `admin123`

**Customer:**
- Email: `customer@blushthreads.com`
- Password: `customer123`

---

## Next Steps

✅ Database data now persists!
- Orders won't be lost on redeploy
- Product catalog updates are saved
- User accounts persist

Happy deploying! 🚀
