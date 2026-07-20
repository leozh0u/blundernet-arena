output "url" {
  description = "Public entry point"
  value       = "http://${aws_lb.main.dns_name}"
}

output "ecr_api" {
  value = aws_ecr_repository.api.repository_url
}

output "ecr_worker" {
  value = aws_ecr_repository.worker.repository_url
}

output "queue_url" {
  value = aws_sqs_queue.moves.url
}
