## RabbitMQ with management

The official RabbitMQ management image includes the broker and its browser dashboard. A generated `openship` account administers the broker. The `openship` virtual host is created on the first boot.

## Connect applications

Use the private `AMQP_URL` through **Use in a project**. Port 5672 stays private; only the authenticated management dashboard gets a domain by default. Use a local tunnel for clients on your machine. Public AMQP TLS and clustering are not configured by this single-node stack.

## Persistence

The persistent volume stores broker state. The node name is fixed as `rabbit@rabbitmq`, so replacing a container keeps the same node identity. Publishers must still declare durable queues and publish persistent messages when they require delivery after a restart. The generated password only initializes an empty broker; redeployment does not overwrite passwords changed in RabbitMQ.

[Official RabbitMQ image](https://hub.docker.com/_/rabbitmq) · [Management plugin](https://www.rabbitmq.com/docs/management)
