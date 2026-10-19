-- Run only after approval, using the existing local QA owner connection.
-- This file never connects to DGX or changes source data/accounts/sessions.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'toss_test_items2_qa_20261019'
     OR inet_server_addr() <> '127.0.0.1'::inet
     OR inet_server_port() <> 15440 THEN
    RAISE EXCEPTION 'Wrong Hermes QA target';
  END IF;
END $$;
GRANT SELECT, INSERT ON public.orders, public.order_items, public.payments, public.shipments TO commerce_t2_qa;
GRANT SELECT ON public.cancel_requests TO commerce_t2_qa;
GRANT INSERT ON public.products, public.product_variants TO commerce_t2_qa;
GRANT UPDATE(unit_price_won, active, version) ON public.product_variants TO commerce_t2_qa;
COMMIT;
