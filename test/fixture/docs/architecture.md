# How the shop runs

The shop is one API on Cloud Run, in front of a Postgres database on Cloud SQL. People reach it through Identity-Aware Proxy.

![The shop on Google Cloud: IAP in front of the Cloud Run API, which keeps orders in Cloud SQL](diagrams/deployment.png)

## Placing an order

A customer's order is checked, stored, and confirmed in one request.

![Placing an order: the API checks the stock, stores the order and answers](diagrams/order.png)
