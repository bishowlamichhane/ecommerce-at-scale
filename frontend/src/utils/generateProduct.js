import fs from 'fs';
import path from 'path';

// Product image mappings based on product type and category
const imageMap = {
  // Bags
  'Backpack': 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=600&h=800&q=80&fit=crop',
  'Handbag': 'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=600&h=800&q=80&fit=crop',
  'Sling Bag': 'https://images.unsplash.com/photo-1590736969955-71cc94901144?w=600&h=800&q=80&fit=crop',
  'Travel Bag': 'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?w=600&h=800&q=80&fit=crop',
  'Messenger Bag': 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=600&h=800&q=80&fit=crop',
  
  // Shoes
  'Heels': 'https://images.unsplash.com/photo-1543163521-9145f931371e?w=600&h=800&q=80&fit=crop',
  'Sneakers': 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=600&h=800&q=80&fit=crop',
  'Boots': 'https://images.unsplash.com/photo-1608234327651-b11e62261ecb?w=600&h=800&q=80&fit=crop',
  'Sandals': 'https://images.unsplash.com/photo-1572099160349-676d6b965ba2?w=600&h=800&q=80&fit=crop',
  'Loafers': 'https://images.unsplash.com/photo-1608234327651-b11e62261ecb?w=600&h=800&q=80&fit=crop',
  'Flats': 'https://images.unsplash.com/photo-1603487565602-fef9af249235?w=600&h=800&q=80&fit=crop',
  
  // Topwear
  'Jacket': 'https://images.unsplash.com/photo-1551028719-00167b16ebc5?w=600&h=800&q=80&fit=crop',
  'Hoodie': 'https://images.unsplash.com/photo-1556821552-5ff63b1ce4f2?w=600&h=800&q=80&fit=crop',
  'T-Shirt': 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=600&h=800&q=80&fit=crop',
  'Sweater': 'https://images.unsplash.com/photo-1556821552-5ff63b1ce4f2?w=600&h=800&q=80&fit=crop',
  'Shirt': 'https://images.unsplash.com/photo-1596777684687-3f6eb89de345?w=600&h=800&q=80&fit=crop',
  'Blazer': 'https://images.unsplash.com/photo-1551028719-00167b16ebc5?w=600&h=800&q=80&fit=crop',
  
  // Bottomwear
  'Jeans': 'https://images.unsplash.com/photo-1542272604-787c62d465d1?w=600&h=800&q=80&fit=crop',
  'Pants': 'https://images.unsplash.com/photo-1542272604-787c62d465d1?w=600&h=800&q=80&fit=crop',
  'Shorts': 'https://images.unsplash.com/photo-1591195853828-11db59a44f6b?w=600&h=800&q=80&fit=crop',
  'Skirt': 'https://images.unsplash.com/photo-1598808503900-d4d1b27d4a8d?w=600&h=800&q=80&fit=crop',
  'Leggings': 'https://images.unsplash.com/photo-1542272604-787c62d465d1?w=600&h=800&q=80&fit=crop',
  
  // Accessories
  'Watch': 'https://images.unsplash.com/photo-1523170335684-f029f8bfe770?w=600&h=800&q=80&fit=crop',
  'Belt': 'https://images.unsplash.com/photo-1553056169-27c196d76601?w=600&h=800&q=80&fit=crop',
  'Scarf': 'https://images.unsplash.com/photo-1573630962159-a35d66e9ed0c?w=600&h=800&q=80&fit=crop',
  'Hat': 'https://images.unsplash.com/photo-1540037404063-61711b8ec5d8?w=600&h=800&q=80&fit=crop',
  'Gloves': 'https://images.unsplash.com/photo-1587854692152-cbe660dbde0f?w=600&h=800&q=80&fit=crop',
  'Sunglasses': 'https://images.unsplash.com/photo-1572635196237-14b3f281503f?w=600&h=800&q=80&fit=crop',
  
  // Fragrance
  'Body Spray': 'https://images.unsplash.com/photo-1587854692152-cbe660dbde0f?w=600&h=800&q=80&fit=crop',
  'Perfume': 'https://images.unsplash.com/photo-1587854692152-cbe660dbde0f?w=600&h=800&q=80&fit=crop',
};

const adjectives = [
  'Classic', 'Modern', 'Trendy', 'Comfy', 'Elegant', 'Stylish', 'Premium', 'Casual',
  'Formal', 'Sporty', 'Chic', 'Cozy', 'Smart', 'Bold', 'Sleek', 'Vibrant'
];

const productNames = [
  'Backpack', 'Handbag', 'Sling Bag', 'Travel Bag', 'Messenger Bag',
  'Heels', 'Sneakers', 'Boots', 'Sandals', 'Loafers', 'Flats',
  'Jacket', 'Hoodie', 'T-Shirt', 'Sweater', 'Shirt', 'Blazer',
  'Jeans', 'Pants', 'Shorts', 'Skirt', 'Leggings',
  'Watch', 'Belt', 'Scarf', 'Hat', 'Gloves', 'Sunglasses',
  'Body Spray', 'Perfume'
];

const categories = ['Home', 'Apparel', 'Accessories', 'Sporting Goods', 'Personal Care', 'Free Items'];
const genders = ['Men', 'Women', 'Girls', 'Boys', 'Unisex'];
const subcategories = ['Bags', 'Shoes', 'Topwear', 'Bottomwear', 'Fragrance', 'Accessories', 'Watches'];
const colors = ['Red', 'Blue', 'Green', 'Black', 'White', 'Gray', 'Brown', 'Pink', 'Yellow', 'Purple', 'Orange', 'Beige'];
const usages = ['Casual', 'Sports', 'Party', 'Ethnic', 'Formal'];

// Function to get image URL for a product
function getImageUrl(productName) {
  for (const [key, url] of Object.entries(imageMap)) {
    if (productName.includes(key)) {
      return url;
    }
  }
  return imageMap['Backpack']; // default fallback
}

// Generate 1000 items
const items = [];

for (let i = 0; i < 1000; i++) {
  const adjective = adjectives[i % adjectives.length];
  const productName = productNames[i % productNames.length];
  const fullName = `${adjective} ${productName}`;
  
  const item = {
    name: fullName,
    price: parseFloat((Math.random() * 450 + 50).toFixed(2)),
    category: categories[i % categories.length],
    gender: genders[i % genders.length],
    subcategory: subcategories[i % subcategories.length],
    color: colors[i % colors.length],
    usage: usages[i % usages.length],
    image: getImageUrl(productName)
  };
  
  items.push(item);
}

// Write to file
const output = `export const items = ${JSON.stringify(items, null, 2)};\n`;
const filePath = path.join(process.cwd(), 'public', 'clothing_items.js');

fs.writeFileSync(filePath, output, 'utf-8');
console.log(`Generated ${items.length} items in ${filePath}`);
