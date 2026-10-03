import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import Cart from './components/Cart.jsx';
import Home from './Home.jsx';


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
        ]
    }
])


createRoot(document.getElementById('root')).render(

    <RouterProvider router={router} />

)
