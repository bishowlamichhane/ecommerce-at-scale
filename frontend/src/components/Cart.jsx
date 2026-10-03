import axios from 'axios';
import React, { useEffect, useState } from 'react'

const Cart = () => {

    const [cartItems, setCartItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState(null);

    const checkout = async () => {
        let bodyData = {
            shipping_address: 'Kathmandu, Dhapasi-7',
            billing_address: 'Kathmandu, Dhapasi-7'
        }
        try {
            const { data } = await axios.post(`http://localhost:5000/orders/place-order`, bodyData);
            setMessage({ ok: true, text: `Order #${data.message.id} is placed. Follow it under "My orders" on the Flash Sale page.` });
            setCartItems([]);
        } catch (error) {
            const response = error.response;
            const text = response?.status === 429
                ? `Too many tries. Try again in ${response.headers['retry-after'] || 1} s.`
                : response?.status === 409
                    ? 'Something in your cart just sold out.'
                    : response?.data?.message || error.message;
            setMessage({ ok: false, text });
        }
    }
    const fetchCartItems = async () => {
        try {
            setLoading(true);
            const { data } = await axios.get(`http://localhost:5000/cart/get-cart-items`)
            
            setCartItems(data.message.products);
            console.log(data.message.products)
            setLoading(false);

        } catch (error) {
            console.error('Error fetching cart items', error);
            setCartItems([])
            setLoading(false);
        } finally {
            setLoading(false);
        }


    }

    const removeFromCart = async (productId, quantity) => {
        const bodyData = { productId: productId, quantity: quantity }
        console.log(bodyData)
        try {
            const { data } = await axios.delete(`http://localhost:5000/cart/remove-item`, { data: bodyData });
            console.log(data.message);
            fetchCartItems();
        } catch (error) {
            console.error('Error removing from cart', error);
        }
    }

    useEffect(() => {
        fetchCartItems();

    }, []);


    if (loading) {
        return <div>Loading....</div>
    }
    return (
        <div className='flex justify-between px-10 py-10 w-full h-[calc(100vh-100px)] '>

            <div className="flex flex-col gap-4 w-1/2 ">

                {cartItems.map((item) => (
                    <div className='flex w-8/10 h-24 border border-white gap-2 items-center relative'>
                        <div className='w-20 h-full'> <img src={item?.image} className='w-full h-full object-cover' /></div>
                        <div className='flex w-90 px-10 border-r border-white flex-col gap-2'><p>{item?.name}</p><p>{item?.price}</p></div>
                        <div className='flex items-center justify-center flex-1 '><span>x</span><p>{item?.quantity}</p></div>
                        <button className='absolute top-0 right-0 bg-red-500 text-white px-4 py-2' onClick={() => removeFromCart(item.id, item.quantity)}>Remove</button>
                    </div>
                ))}

            </div>


            <div className="flex flex-col gap-4 w-1/2 ">
                <p>Total Products:{cartItems.length}</p>
                <p>Total Price: {cartItems.reduce((total, item) => total + item.price * item.quantity, 0).toFixed(2)}</p>
                <button className='bg-blue-500 text-white px-4 py-2' onClick={checkout}>Checkout</button>
                {message && <p className={message.ok ? 'text-green-400' : 'text-red-400'}>{message.text}</p>}
            </div>
        </div>
    )
}

export default Cart