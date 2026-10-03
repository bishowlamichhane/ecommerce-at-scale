import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import Cart from './components/Cart.jsx';
import Home from './Home.jsx';
import FlashSale from './components/FlashSale.jsx';
import { setupShopperId } from './utils/shopperId.js';

setupShopperId();

const router = createBrowserRouter([
    {
        path: '/',
        element: <App />,
        children: [

            {
                path: '/',
                element: <Home />

            }
            , {

                path: '/cart',
                element: <Cart />
            }
            , {
                path: '/flash-sale',
                element: <FlashSale />
            }
        ]
    }
])


createRoot(document.getElementById('root')).render(

    <RouterProvider router={router} />

)
